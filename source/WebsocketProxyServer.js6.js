const WebSocketServer = require("ws").Server;

const {PermissionDispatcher, PermissionChecker, UniqueIdentifierFactory, MetadataObserver,
       Glue}= require("establishment-node-service-core");

const ProxiedWebsocketConnection = require("./ProxiedWebsocketConnection.js6.js");

class WebsocketProxyServer {
    constructor(config) {
        this.config = config;
        this.uidFactory = new UniqueIdentifierFactory(config.uidFactory);
        this.permissionChecker = new PermissionChecker(config.permissionChecker);
        this.permissionDispatcher = new PermissionDispatcher();
        this.metadataObserver = new MetadataObserver(config.metadataObserver);

        this.permissionChecker.link(this.permissionDispatcher);

        this.proxies = [];
    }

    startInstance(proxyEntry) {
        if (!proxyEntry.hasOwnProperty("target")) {
            Glue.logger.error("Establishment::WebsocketProxyServer: invalid config: proxyEntry does not contain " +
                              "\"target\" field!");
            Glue.logger.error();
            this.stop();
            return false;
        }

        if (!proxyEntry.hasOwnProperty("listen")) {
            Glue.logger.error("Establishment::WebsocketProxyServer: invalid config: proxyEntry does not contain " +
                              "\"listen\" field!");
            Glue.logger.error("Establishment::WebsocketProxyServer: skipping mapping: " + proxyEntry);
            this.stop();
            return false;
        }

        let webSocketServer = new WebSocketServer(proxyEntry.listen);

        webSocketServer.on("connection", (webSocket, req) => {
            webSocket.upgradeReq = req;
            new ProxiedWebsocketConnection(proxyEntry, webSocket, this.permissionDispatcher, this.permissionChecker,
                                           this.metadataObserver);
        });

        this.proxies.push({
            "webSocketServer": webSocketServer,
            "config": proxyEntry
        });
    }

    start() {
        for (let proxyEntry of this.config.mapping) {
            this.startInstance(proxyEntry);
        }
    }
}

module.exports = WebsocketProxyServer;
