const WebSocket = require("ws");
const cookieParser = require("cookie");

const {Queue} = require("establishment-node-core");
const {Glue} = require("establishment-node-service-core");

class ProxiedWebsocketConnection {
    constructor(config, webSocket, permissionDispatcher, permissionChecker, metadataObserver) {
        this.config = config;
        this.webSocket = webSocket;
        this.toClientMessageTaskQueue = new Queue();
        this.toTargetMessageTaskQueue = new Queue();
        this.permissionDispatcher = permissionDispatcher;
        this.permissionChecker = permissionChecker;
        this.metadataObserver = metadataObserver;

        this.cookie = this.webSocket.upgradeReq.headers.cookie;
        this.ip = this.webSocket.upgradeReq.headers["real_ip"];

        this.crossSessionId = null;

        this.destroyed = false;

        Glue.logger.info("Establishment::ProxiedWebsocketConnection: new connection from ip: " + this.ip);

        this.parseConfig();
        this.parseCookie();

        this.webSocket.on("message", (message) => {
            this.webSocketProcessMessage(message);
        });

        this.webSocket.on("error", (err) => {
            Glue.logger.error("Establishment::ProxiedWebsocketConnection: closing connection because of client " +
                              "websocket error: " + err);
            this.webSocket.close();
            this.webSocket = null;
            this.destroy();
        });

        this.webSocket.on("close", () => {
            this.webSocket = null;
            this.destroy();
        });

        this.targetWebSocket = new WebSocket(this.config.target);

        this.targetWebSocket.on("message", (message) => {
            this.targetWebSocketProcessMessage(message);
        });

        this.targetWebSocket.on("error", (err) => {
            Glue.logger.error("Establishment::ProxiedWebsocketConnection: closing connection because of target " +
                              "websocket error: " + err);
            this.targetWebSocket.close();
            this.targetWebSocket = null;
            this.destroy();
        });

        this.targetWebSocket.on("close", () => {
            this.targetWebSocket = null;
            this.destroy();
        });
    }

    getSession() {
        return this.crossSessionId;
    }

    getUserId() {
        return this.userId;
    }

    parseCookie() {
        if (this.cookie == null) {
            this.processIdentificationResult(ProxiedWebsocketConnection.getGuestId());
            return;
        }

        let cookies = cookieParser.parse(this.cookie);

        if (!cookies.hasOwnProperty("crossSessionId")) {
            this.processIdentificationResult(ProxiedWebsocketConnection.getGuestId());
            return;
        }

        if (Glue.registryKeeper.get("enable-csrf") == "true") {
            if (!cookies.hasOwnProperty("csrftoken")) {
                // TODO: should check csrftoken against Django's map
                //Global.logger.warn("PermissionChecker: invalid cookie! (csrftoken field not found)");
                this.processIdentificationResult(-1);
                return;
            }
        }

        this.crossSessionId = cookies.crossSessionId;

        if (this.userId == null && (this.outgoingNeedUserPermission || this.incomingNeedUserPermission)) {
            this.requestIdentification();
        }
    }

    parseConfig() {
        if (!this.config.hasOwnProperty("outgoing")) {
            this.config.outgoing = {
                pending: ProxiedWebsocketConnection.DEFAULT_OUTGOING_PENDING,
                permission: ProxiedWebsocketConnection.DEFAULT_OUTGOING_PERMISSION
            };
        } else {
            if (!this.config.outgoing.hasOwnProperty("pending")) {
                this.config.outgoing.pending = ProxiedWebsocketConnection.DEFAULT_OUTGOING_PENDING;
            }
            if (!this.config.outgoing.hasOwnProperty("permission")) {
                this.config.outgoing.permission = ProxiedWebsocketConnection.DEFAULT_OUTGOING_PERMISSION;
            }
        }

        if (!this.config.hasOwnProperty("incoming")) {
            this.config.incoming = {
                pending: ProxiedWebsocketConnection.DEFAULT_INCOMING_PENDING,
                permission: ProxiedWebsocketConnection.DEFAULT_INCOMING_PERMISSION
            };
        } else {
            if (!this.config.incoming.hasOwnProperty("pending")) {
                this.config.incoming.pending = ProxiedWebsocketConnection.DEFAULT_INCOMING_PENDING;
            }
            if (!this.config.incoming.hasOwnProperty("permission")) {
                this.config.incoming.permission = ProxiedWebsocketConnection.DEFAULT_INCOMING_PERMISSION;
            }
        }

        this.incomingStreamPermission = false;
        this.incomingNeedUserPermission = false;
        if (this.config.incoming.permission.toLowerCase() == "user") {
            this.incomingNeedUserPermission = true;
        } else if (this.config.incoming.permission.toLowerCase()== "stream") {
            this.incomingNeedUserPermission = true;
            if (this.config.incoming.hasOwnProperty("checkStream")) {
                this.incomingNeedStreamPermission = true;
            }
        }

        this.outgoingStreamPermission = false;
        this.outgoingNeedUserPermission = false;
        if (this.config.outgoing.permission.toLowerCase() == "user") {
            this.outgoingNeedUserPermission = true;
        } else if (this.config.outgoing.permission.toLowerCase() == "stream") {
            this.outgoingNeedUserPermission = true;
            if (this.config.outgoing.hasOwnProperty("checkStream")) {
                this.outgoingNeedStreamPermission = true;
            }
        }
    }

    requestIdentification() {
        if (this.crossSessionId == null) {
            Glue.logger.error("Establishment::ProxiedWebsocketConnection: requestIdentification called but there is " +
                              "no crossSessionId!");
            return;
        }
        this.permissionDispatcher.registerIdentification(this);
        this.permissionChecker.requestIdentification(this.crossSessionId);
    }

    requestPermission(channel) {
        this.permissionDispatcher.registerPermission(this, channel);
        this.permissionChecker.requestPermission(this.userId, channel);
    }

    processIdentificationResult(userId) {
        if (userId == -1) {
            let error = {
                message: "Decline websocket connection!",
                reason: "Invalid sessionId"
            };
            this.send(JSON.stringify(error));
            this.destroy();
            return;
        }

        this.userId = userId;

        if (this.userId == 0) {
            let guestConnectionLimit = Glue.registryKeeper.get("max-guests");
            guestConnectionLimit = parseInt(guestConnectionLimit);
            if (guestConnectionLimit > 0) {
                if (this.metadataObserver.getTotalGuestConnections() >= guestConnectionLimit) {
                    this.userId = -1;
                    this.destroy();
                    return;
                }
            }
        }

        if (this.incomingNeedStreamPermission) {
            this.requestPermission(this.config.incoming.checkStream);
        } else {
            this.executeDelayedWork(this.toTargetMessageTaskQueue);
        }

        if (this.outgoingNeedStreamPermission && (!this.incomingNeedUserPermission ||
            (this.incomingNeedUserPermission && this.config.incoming.checkStream != this.config.outgoing.checkStream))) {
            this.requestPermission(this.config.outgoing.checkStream);
        } else {
            this.executeDelayedWork(this.toClientMessageTaskQueue);
        }
    }

    processPermissionResult(channel, result, reason) {
        if (this.destroyed) {
            return;
        }
        if (result) {
            Glue.logger.info("Establishment::ProxiedWebsocketConnection: permission to subscribe #" + channel +
                             " accepted! (" + reason + ")");
            if (this.outgoingNeedStreamPermission) {
                if (this.config.outgoing.checkStream == channel) {
                    if (!this.outgoingStreamPermission) {
                        this.outgoingStreamPermission = true;
                        this.executeDelayedWork(this.toClientMessageTaskQueue);
                    }
                }
            }
            if (this.incomingNeedStreamPermission) {
                if (this.config.incoming.checkStream == channel) {
                    if (!this.incomingStreamPermission) {
                        this.incomingStreamPermission = true;
                        this.executeDelayedWork(this.toTargetMessageTaskQueue);
                    }
                }
            }
        } else {
            Glue.logger.warn("Establishment::ProxiedWebsocketConnection: permission to subscribe #" + channel +
                             " declined! (" + reason + ")");
        }
    }

    webSocketProcessMessage(message) {
        if (this.destroyed) {
            return;
        }

        this.sendToTargetSafe(message);
    }

    targetWebSocketProcessMessage(message) {
        if (this.destroyed) {
            return;
        }

        this.sendToClientSafe(message);
    }

    handleWebSocketError(error) {
        if (this.destroyed) {
            return;
        }
        if (error != null) {
            Glue.logger.error("Establishment::ProxiedWebsocketConnection: Websocket send error: " + error);
            if (error == "Error: This socket has been ended by the other party" || error == "Error: not opened") {
                Glue.logger.error("Establishment::ProxiedWebsocketConnection: Websocket force-close.");
                this.webSocket.close();
                this.webSocket = null;
                this.destroy();
            }
        }
    }

    handleTargetWebSocketError(error) {
        // Consume already triggered errors
        if (this.destroyed) {
            return;
        }
        if (error != null) {
            Glue.logger.error("Establishment::ProxiedWebsocketConnection: Websocket send error: " + error);
            if (error == "Error: This socket has been ended by the other party" || error == "Error: not opened") {
                Glue.logger.error("Establishment::ProxiedWebsocketConnection: Websocket force-close.");
                this.targetWebSocket.close();
                this.targetWebSocket = null;
                this.destroy();
            }
        }
    }

    havePermissionToSendToClient() {
        if (this.outgoingNeedUserPermission) {
            if (this.userId > 0) {
                if (this.outgoingNeedStreamPermission) {
                    return this.outgoingStreamPermission;
                } else {
                    return true;
                }
            }
            return false;
        }
        return true;
    }

    havePermissionToSendToTarget() {
        if (this.incomingNeedUserPermission) {
            if (this.userId > 0) {
                if (this.incomingNeedStreamPermission) {
                    return this.incomingStreamPermission;
                } else {
                    return true;
                }
            }
            return false;
        }
        return true;
    }

    discardMessagesToClient() {
        return this.config.outgoing.pending.toLowerCase() != "queue-all";
    }

    discardMessagesToTarget() {
        return this.config.incoming.pending.toLowerCase() != "queue-all";
    }

    sendToClientSafe(message) {
        if (this.havePermissionToSendToClient()) {
            this.sendToClient(message);
        } else {
            if (!this.discardMessagesToClient()) {
                this.toClientMessageTaskQueue.push({
                    "func": "sendToClient",
                    "param0": message
                });
            }
        }
    }

    sendToTargetSafe(message) {
        if (this.havePermissionToSendToTarget()) {
            this.sendToTarget(message);
        } else {
            if (!this.discardMessagesToTarget()) {
                this.toTargetMessageTaskQueue.push({
                    "func": "sendToTarget",
                    "param0": message
                });
            }
        }
    }

    sendToClient(message) {
        if (this.webSocket != null) {
            this.webSocket.send(message, (error) => {
                this.handleWebSocketError(error);
            });
        } else {
            this.destroy();
        }
    }

    sendToTarget(message) {
        if (this.targetWebSocket != null) {
            this.targetWebSocket.send(message, (error) => {
                this.handleTargetWebSocketError(error);
            });
        } else {
            this.destroy();
        }
    }

    executeDelayedWork(taskQueue) {
        while (!taskQueue.empty()) {
            let request = taskQueue.pop();
            if (request["func"] == "sendToClient") {
                this.sendToClient(request["param0"]);
            } else if (request["func"] == "sendToTarget") {
                this.sendToTarget(request["param0"]);
            } else {
                Glue.logger.critical("Establishment::ProxiedWebsocketConnection: undefined request-func: " +
                                     request["func"]);
            }
        }
    }

    destroy() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;

        if (this.webSocket != null) {
            if (this.havePermissionToSendToClient()) {
                this.executeDelayedWork(this.toClientMessageTaskQueue);
            }
            this.webSocket.close();
            this.webSocket = null;
        }

        if (this.targetWebSocket != null) {
            if (this.havePermissionToSendToTarget()) {
                this.executeDelayedWork(this.toTargetMessageTaskQueue);
            }
            this.targetWebSocket.close();
            this.targetWebSocket = null;
        }

        this.cookie = null;
        this.ip = null;
    }

    static getGuestId() {
        if (Glue.registryKeeper.get("enable-guests") == "true") {
            return 0;
        }
        return -1;
    }
}

ProxiedWebsocketConnection.DEFAULT_OUTGOING_PENDING = "queue-all";
ProxiedWebsocketConnection.DEFAULT_INCOMING_PENDING = "queue-all";
ProxiedWebsocketConnection.DEFAULT_OUTGOING_PERMISSION = "all";
ProxiedWebsocketConnection.DEFAULT_INCOMING_PERMISSION = "all";

module.exports = ProxiedWebsocketConnection;
