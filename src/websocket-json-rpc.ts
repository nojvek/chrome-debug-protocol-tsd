import * as WebSocket from 'ws'
import * as http from 'http'
import WebSocketServer = WebSocket.Server

import {EventEmitter} from 'events'
import * as JsonRpc from './jsonRpc'

export class Client extends EventEmitter implements JsonRpc.Client{
    private static ConnectTimeout = 5000

    private _connectedPromise: Promise<Client>
    private _webSocket: WebSocket
    private _pendingMessageMap: Map<number, {resolve: Function, reject: Function}> = new Map()
    private _nextMessageId: number = 0

    static connect(address: string): Promise<Client> {
        const client = new Client(address)
        return client._connectedPromise
    }

    constructor(address: string){
        super()

        this._connectedPromise = new Promise((resolve, reject) => {
            try {
                console.log("creating", address)
                this._webSocket = new WebSocket(address)
            } catch (e) {
                return reject(e)
            }

            // If connection is hung, error after timeout
            const ws = this._webSocket
            setTimeout(() => reject(new Error('WebSocket connection timed out')), Client.ConnectTimeout)

            ws.on('error', reject)
            ws.on('open', () => {
                // Replace the promise-rejecting handler
                ws.removeListener('error', reject)
                ws.on('error', e => this.emit('error', e))
                ws.on('close', () => this.emit('close'))
                resolve(this)
            })

            ws.on('message', message => this._handleMessage(message))
        })
    }

    private _handleMessage(messageStr: string) {
        let message: JsonRpc.Response & JsonRpc.Notification

        // Ensure JSON is not malformed
        try {
            message = JSON.parse(messageStr)
        } catch (e) {
            return this.emit('error', e)
        }

        // All messages will be emitted so host can log if needed
        console.log("Client <", JSON.stringify(message))
        this.emit('receive', message)

        if (!message){
            this.emit('error', new Error(`Malformed message: ${messageStr}`))
        } else if (message.id) {
            if (this._pendingMessageMap.has(message.id)) {
                // Resolve promise from pending message
                const promise = this._pendingMessageMap.get(message.id)
                if (message.result) {
                    promise.resolve(message.result)
                } else if (message.error) {
                    promise.reject(message.error)
                } else {
                    this.emit('error', new Error(`Invalid message: ${messageStr}`))
                }
            } else {
                this.emit('error', new Error(`Response with id ${message.id} has no pending request.`))
            }
        } else if (message.method) {
            // Server has sent a notification
            this.emit(message.method, message.params)
        }
    }

    private _send(message: JsonRpc.Notification | JsonRpc.Request) {
        console.log("Client >", JSON.stringify(message))
        this.emit('send', message);
        this._webSocket.send(JSON.stringify(message))
    }

    send(method: string, params?: any): Promise<any> {
        const id = ++this._nextMessageId;
        const message: JsonRpc.Request = {id, method, params}

        return new Promise((resolve, reject) => {
            this._pendingMessageMap.set(id, {resolve, reject})
            this._connectedPromise.then(() => {
                this._send(message)
            })
        })
    }

    notify(method: string, params?: any): void {
        const message: JsonRpc.Notification = {method, params}
        this._send(message)
    }
}

export class Server extends EventEmitter implements JsonRpc.Server {
    private _replyHandlerMap: Map<string, (params: any) => JsonRpc.PromiseOrNot<any>> = new Map()
    private _webSocketServer: WebSocketServer

    constructor (httpServer: http.Server) {
        super()

        const wss = this._webSocketServer = new WebSocketServer({server: httpServer})
        wss.on('error', (e) => this.emit('error', e))

        wss.on('connection', ws => {
            ws.on('message', message => this._handleMessage(message, ws))
        })
    }

    private _handleMessage(messageStr: string, ws: WebSocket): void {
        let message: JsonRpc.Request

        // Ensure JSON is not malformed
        try {
            message = JSON.parse(messageStr)
        } catch (e) {
            return this._sendError(ws, message, JsonRpc.ErrorCode.ParseError)
        }

        // Emit message so caller can log if needed
        console.log("Server <", JSON.stringify(message))
        this.emit('receive', message, ws)

        // Ensure method is atleast defined
        if (message && message.method && typeof message.method == "string") {
            if (message.id && typeof message.id === "number") {
                const handler = this._replyHandlerMap.get(message.method)
                // Handler is defined so lets call it
                if (handler) {
                    try {
                        const result: JsonRpc.PromiseOrNot<any> = handler.call(null, message.params)
                        if (result instanceof Promise) {
                            // Result is a promise, so lets wait for the result and handle accordingly
                            result.then((actualResult: any) => {
                                this._send(ws, {id: message.id, result: result || {}})
                            }).catch((error: Error) => {
                                this._sendError(ws, message, JsonRpc.ErrorCode.InternalError, error);
                            })
                        } else {
                            // Result is not a promise so send immediately
                            this._send(ws, {id: message.id, result: result || {}})
                        }
                    } catch (error) {
                        this._sendError(ws, message, JsonRpc.ErrorCode.InternalError, error);
                    }
                } else {
                    this._sendError(ws, message, JsonRpc.ErrorCode.MethodNotFound)
                }
            } else {
                // Message is a notification, so just emit
                this.emit(message.method, message.params)
            }
        } else {
            // No method property, send InvalidRequest error
            this._sendError(ws, message, JsonRpc.ErrorCode.InvalidRequest)
        }
    }

    private _send(ws: WebSocket, message: JsonRpc.Response | JsonRpc.Notification ) {
        console.log("Server >", JSON.stringify(message))
        this.emit('send', message);
        ws.send(JSON.stringify(message))
    }

    private _sendError(ws: WebSocket, request: JsonRpc.Request, errorCode: JsonRpc.ErrorCode, errorData?: any) {
        this._send(ws, <JsonRpc.Response>{
            id: request && request.id || -1,
            error: this._errorFromCode(errorCode, errorData, request.method)
        })
    }

    private _errorFromCode(code: JsonRpc.ErrorCode, data?: any, method?: string): JsonRpc.Error {
        let message = ""

        switch (code) {
            case JsonRpc.ErrorCode.InternalError:
                message =  `InternalError: Internal Error when calling '${method}'`
                break
            case JsonRpc.ErrorCode.MethodNotFound:
                message =  `MethodNotFound: '${method}' wasn't found`
                break
            case JsonRpc.ErrorCode.InvalidRequest:
                message =  "InvalidRequest: JSON sent is not a valid request object"
                break
            case JsonRpc.ErrorCode.ParseError:
                message =  "ParseError: invalid JSON received"
                break
        }

        return {code, message, data}
    }

    reply(method: string, handler: (params: any) => JsonRpc.PromiseOrNot<any>): void {
        this._replyHandlerMap.set(method, handler)
    }

    notify (method: string, params?: any): void {
        // Broadcast message to all clients
        this._webSocketServer.clients.forEach(ws => {
            const message: JsonRpc.Notification = {method, params}
            this._send(ws, message)
        })
    }
}