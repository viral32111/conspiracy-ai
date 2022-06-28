// Import from native modules
import { URL } from "url"
import { setTimeout } from "timers/promises"
import { once } from "events"

// Import from my scripts
import { request } from "../api.js"
import { WebSocket } from "../../websocket/websocket.js"
import { APPLICATION_NAME, DISCORD_API_VERSION } from "../../config.js"
import { OperationCode as WSOperationCode, CloseCode } from "../../websocket/types.js"
import { Get, Payload, OperationCode, ActivityType, StatusType, DispatchEvent } from "./types.js"
import { updateUser } from "../state.js"

// An implementation of the Discord Gateway.
// https://discord.com/developers/docs/topics/gateway

// The non-1000 WebSocket close code to use for resuming after not receiving a heartbeat acknowledgement
const RECONNECT_CLOSE_CODE = 4000

// Should compression be used? No it should not
const USE_COMPRESSION = false

export class Gateway extends WebSocket {

	// Holds the current payload sequence number, used when sending heartbeats
	private sequenceNumber: number | null = null

	// For periodic heartbeating in the background
	private heartbeatTask?: Promise<void>
	private heartbeatController = new AbortController()

	// Session identifier from the Ready event
	private sessionIdentifier?: string

	// Instansiate to connect to a provided gateway server
	constructor( baseUrl: string ) {

		// Parse the provided URL & add the required querystring to it
		// https://discord.com/developers/docs/topics/gateway#connecting-to-the-gateway
		const connectionUrl = new URL( baseUrl )
		connectionUrl.search = new URLSearchParams( {
			"encoding": "json",
			"compress": USE_COMPRESSION.toString(),
			"v": DISCORD_API_VERSION.toString()
		} ).toString()

		// Initialise the base class with the URL above
		super( connectionUrl )

		// Register event handlers for the underlying websocket to methods on this class
		this.once( "open", this.onWebSocketOpen.bind( this ) )
		this.once( "close", this.onWebSocketClose.bind( this ) )
		this.on( "text", this.onWebSocketText.bind( this ) )

	}

	// Use this to instansiate, unless you want to provide your own gateway URL
	public static async create(): Promise<Gateway> {

		// Fetch the gateway metadata for bots
		const metadata: Get = await request( "gateway/bot" )

		// Return a new gateway object using the websocket URL from the metadata
		return new Gateway( metadata.url )

	}

	// Sends a payload to the gateway as JSON
	private send( code: OperationCode, data: any ) {
		this.sendFrame( WSOperationCode.Text, Buffer.from( JSON.stringify( {
			"op": code,
			"d": data
		} ) ) )
	}

	// Sends a heartbeat and checks for acknowledgement
	private async sendHeartbeat() {
		this.send( OperationCode.Heartbeat, this.sequenceNumber )

		const isAcknowledged = await Promise.race( [
			once( this, "heartbeatAcknowledge" ),
			setTimeout( 5000, false ) // { signal: this.heartbeatController.signal }
		] )

		// If we never receive an acknowledgement, then the connection may be zombied.
		// We should disconnect with a non-1000 close code, reconnect and attempt to send Resume (Opcode 6)
		if ( !isAcknowledged ) this.close( RECONNECT_CLOSE_CODE, "Never received heartbeat acknowledgement" )

	}

	// Background task that sends periodic heartbeats on the specified interval
	private async startHeartbeating( interval: number ) {

		// Used to check if the first heartbeat has been sent yet
		let sentInitialBeat = false

		// Run continuously while the connection is open...
		while ( this.isConnected() ) {

			// Attempt to wait the specified interval
			try {

				// If this is the first heartbeat we are sending then add a bit of jitter to the interval
				if ( sentInitialBeat === false ) {
					await setTimeout( interval * Math.random(), undefined, {
						signal: this.heartbeatController.signal
					} )
	
					sentInitialBeat = true

				// Otherwise, wait the usual interval
				} else {
					await setTimeout( interval, undefined, {
						signal: this.heartbeatController.signal
					} )
				}

			// Stop running if we encounter an error
			} catch ( error ) {

				// Forward errors unless it is an abort signal error (which is expected)
				if ( error instanceof Error ) {
					if ( error.name !== "AbortError" ) this.emit( "error", error )
				}

				break

			}

			// Do not continue if the abort signal has been set
			if ( this.heartbeatController.signal.aborted ) break

			// Send a heartbeat
			await this.sendHeartbeat()

		}

	}

	// Processes dispatch events before they are emitted
	private handleDispatchEvent( name: string, data: any ) {

		if ( name === DispatchEvent.Ready ) {
			console.debug( data[ "user" ] )
			console.debug( data[ "guilds" ] )
			console.debug( data[ "application" ] )

			const user = updateUser( data[ "user" ] )
			console.debug( user.id, user.username, user.discriminator )

		} else if ( name === DispatchEvent.GuildCreate ) {
			console.debug( data )

		} else {
			console.debug( "Unhandled dispatch event:", name )
		}

	}

	// Event that runs when the underlying websocket connection has opened
	private onWebSocketOpen() {

	}

	// Event that runs when the underlying websocket connection has closed
	private async onWebSocketClose( code: CloseCode | number ) { // , reason?: string

		// Stop background heartbeating & wait for it to finish
		this.heartbeatController.abort()
		await this.heartbeatTask

		// Cleanup so we are ready for another run
		this.heartbeatTask = undefined
		this.heartbeatController = new AbortController()

		// If we closed with the intention to reconnect afterwards...
		if ( code == RECONNECT_CLOSE_CODE ) {

			// Wait between 1 and 5 seconds
			await setTimeout( Math.floor( Math.random() * 4000 ) + 1000 )

			// Reopen the connection
			this.open()

		// Otherwise, cleanup the rest of the class properties
		} else {
			this.sessionIdentifier = undefined
			this.sequenceNumber = null
		}

	}

	// Event that runs when the underlying websocket has received a plaintext message
	private async onWebSocketText( message: string ) {

		// Parse the message as a standard gateway payload
		const payload: Payload = JSON.parse( message )

		// Update the sequence number if it is valid
		if ( payload.s ) this.sequenceNumber = payload.s

		// DEBUGGING
		console.debug( "\nOperation Code:", payload.op )
		console.debug( "Event Data:", payload.d )
		console.debug( "Sequence Number:", payload.s )
		console.debug( "Event Name:", payload.t )

		// If this is the initial message...
		if ( payload.op === OperationCode.Hello ) {

			// Do not continue if we are already heartbeating (this should never happen!)
			if ( this.heartbeatTask ) return this.emit( "error", Error( "Already heartbeating?" ) )

			// Start heartbeating in the background with the interval given to us
			this.heartbeatTask = this.startHeartbeating( payload.d[ "heartbeat_interval" ] )

			// If we have a session identifier, then we should try to resume
			if ( this.sessionIdentifier !== undefined ) {
				this.send( OperationCode.Resume, {
					"token": process.env[ "BOT_TOKEN" ],
					"session_id": this.sessionIdentifier,
					"seq": this.sequenceNumber
				} )

			// Otherwise, send a fresh identify
			} else {
				this.send( OperationCode.Identify, {
					"token": process.env[ "BOT_TOKEN" ],
					"intents": 32767, // Everything
					"compress": USE_COMPRESSION,
					"large_threshold": 250, // This is the max
					"presence": {
						"afk": false,
						"since": null,
						"status": StatusType.Online,
						"activities": [ {
							"name": "Hello World!",
							"type": ActivityType.Playing
						} ]
					},
					"properties": {
						"os": process.platform,
						"browser": APPLICATION_NAME,
						"device": APPLICATION_NAME,
					}
				} )
			}

		// Call the heartbeat acknowledgement event
		} else if ( payload.op === OperationCode.HeartbeatAcknowledgement ) {
			this.emit( "heartbeatAcknowledge", true )

		// Send a heartbeat if one is requested
		} else if ( payload.op === OperationCode.Heartbeat ) {
			await this.sendHeartbeat()

		// Reconnect if requested
		} else if ( payload.op === OperationCode.Reconnect ) {
			this.close( RECONNECT_CLOSE_CODE, "Client reconnect requested" )

		// Session is reported as invalid after attempt to resume
		} else if ( payload.op === OperationCode.InvalidSession ) {

			// Reconnect and resume if we can, otherwise just close
			if ( payload.d === true ) {
				this.close( RECONNECT_CLOSE_CODE, "Session reported as invalid (will attempt resume on reconnect)" )
			} else {
				this.close( CloseCode.GoingAway, "Session reported as invalid" )
			}

		// If this is an event dispatch...
		} else if ( payload.op === OperationCode.Dispatch && payload.t !== undefined ) {

			// If this is the ready event then store the session identifier
			if ( payload.t === DispatchEvent.Ready ) this.sessionIdentifier = payload.d[ "session_id" ]

			// TODO: Handle the event internally (e.g. updating state)
			this.handleDispatchEvent( payload.t, payload.d )

			// TODO: Emit the event once internal event handling is done (e.g. state is up-to-date)
			// this.emit( payload.t, payload.d )

		// Error if the received opcode is not handled above
		} else {
			this.emit( "error", Error( "Unknown gateway operation code" ) )
		}

	}

}
