import crypto from 'crypto';
import fs from 'fs';
import SwarmConnection from './swarmconnection/SwarmConnection.js';
import { getLocalFileInfo } from './kachery.js';
import Stream from 'stream';
import { sleepMsec } from './common/util.js';
import { log } from './common/log.js';

const MAX_BYTES_PER_DOWNLOAD_REQUEST = 20e6;

class PeerDiscoveryEngine3 {
    constructor({
        nodeId,
        udpConnectionManager,
        swarmName
    }) {
        this._nodeId = nodeId;
        this._udpConnectionManager = udpConnectionManager;
        this._swarmName = swarmName;
        this._onPeerNodeInfoChangedCallbacks = [];
        this._nodeInfo = null;
        this._halt = false;
        this._peerNodeInfos = {}; // peerId / {timestamp, nodeInfo}

        // this._remoteServerInfo = {
        //     address: '52.9.11.30', // aws
        //     port: 44501
        // };
        this._remoteServerInfo = {
            address: 'localhost',
            port: 3008
        };

        this._udpConnection = null;

        this._start();
    }
    onPeerNodeInfoChanged(cb) {
        this._onPeerNodeInfoChangedCallbacks.push(cb);
    }
    setNodeInfo(nodeInfo) {
        if (JSONStringifyDeterministic(nodeInfo) === JSONStringifyDeterministic(this._nodeInfo || {})) {
            return;
        }
        this._nodeInfo = nodeInfo;
        this._sendAnnounceMessages();
    }
    leave() {
        this._halt = true;
    }
    forgetNode(nodeId) {
        if (nodeId in this._peerNodeInfos) {
            delete this._peerNodeInfos[nodeId];
        }
    }
    _sendAnnounceMessage() {
        if ((this._udpConnection) && (this._nodeInfo)) {
            const msg = {
                type: 'announceSwarmNode',
                swarmName: this._swarmName,
                nodeInfo: this._nodeInfo
            };
            this._udpConnection.sendMessage(msg);
        }
    }
    _handleLocateSwarmNodesResponse({nodeInfos}) {
        for (let nodeId in nodeInfos) {
            if (nodeId !== this._nodeId) {
                const nodeInfo = nodeInfos[nodeId];
                if ((nodeId in this._peerNodeInfos) && (JSONStringifyDeterministic(nodeInfo) === (JSONStringifyDeterministic(this._peerNodeInfos[nodeId])))) {
                    // no change
                }
                else {
                    this._peerNodeInfos[nodeId] = nodeInfo;
                    this._onPeerNodeInfoChangedCallbacks.forEach(cb => {
                        cb({peerId: nodeId, peerNodeInfo: nodeInfos[nodeId]});
                    });
                }
            }
        }
    }
    _handleUdpMessage(msg) {
        if (msg.type === 'locateSwarmNodesResponse') {
            const nodeInfos = msg.nodeInfos;
            this._handleLocateSwarmNodesResponse({nodeInfos});
        }
    }
    async _startLocatingNodesInSwarm() {
        while (true) {
            if (this._halt) return;
            if (this._udpConnection) {
                const msg = {
                    type: 'locateSwarmNodes',
                    swarmName: this._swarmName
                };
                this._udpConnection.sendMessage(msg);
            }
            await sleepMsec(5000);
        }
    }
    async _startAnnouncing() {
        while (true) {
            if (this._halt) return;
            this._sendAnnounceMessage();
            await sleepMsec(20000);
        }
    }
    async _startMaintainingConnection() {
        while (true) {
            if (this._halt) return;
            if (!this._udpConnection) {
                const C = this._udpConnectionManager.createOutgoingConnection({
                    remoteAddress: this._remoteServerInfo.address,
                    remotePort: this._remoteServerInfo.port,
                });
                C.onMessage(msg => this._handleUdpMessage(msg));
                C.onConnect(() => {
                    if (!this._udpConnection) {
                        this._udpConnection = C;
                    }
                    this._sendAnnounceMessage();
                });
                C.onError(() => {
                    if (C === this._udpConnection) {
                        this._udpConnection = null;
                    }
                })
                C.onDisconnect(() => {
                    if (C === this._udpConnection) {
                        this._udpConnection = null;
                    }
                });
            }
            
            await sleepMsec(10000);
        }
    }
    async _start() {
        this._startMaintainingConnection();
        this._startLocatingNodesInSwarm();
        this._startAnnouncing();
    }
}

class KacheryChannelConnection {
    constructor({keyPair, nodeId, channelName, protocolVersion, feedManager, udpConnectionManager, opts}) {
        this._keyPair = keyPair; // The keypair used for signing message, the public key agrees with the node id
        this._udpConnectionManager = udpConnectionManager;
        this._nodeId = nodeId; // The node id, determined by the public key in the keypair
        this._nodeInfo = null; // The information to be reported to the other nodes in the swarm -- like the host and port (for listening for websockets)
        this._channelName = channelName; // Name of the channel (related to the swarmName)
        this._feedManager = feedManager; // The feed manager (feeds are collections of append-only logs)
        this._protocolVersion = protocolVersion;
        this._halt = false; // Whether we have left this channel (see .leave())
        this._opts = opts;
        this._swarmName = 'kachery:' + this._channelName;

        // Create the swarm connection
        const swarmName = this._swarmName;
        this._swarmConnection = new SwarmConnection({
            udpConnectionManager,
            keyPair,
            nodeId,
            swarmName,
            protocolVersion,
            opts
        });

        // Listen for seeking messages (when a peer is seeking a file or feed)
        this._swarmConnection.createPeerMessageListener(
            (fromNodeId, msg) => {return (msg.type === 'seeking');}
        ).onMessage((fromNodeId, msg) => {
            this._handlePeerSeeking(fromNodeId, msg);
        });

        // Listen for peer requests
        this._swarmConnection.onPeerRequest(({fromNodeId, requestBody, onResponse, onError, onFinished}) => {
            this._handlePeerRequest({fromNodeId, requestBody, onResponse, onError, onFinished});
        });

        this._peerDiscoveryEngine = new PeerDiscoveryEngine3({
            nodeId: this._nodeId,
            udpConnectionManager: this._udpConnectionManager,
            swarmName: this._swarmName
        });
        this._peerDiscoveryEngine.onPeerNodeInfoChanged(({peerId, peerNodeInfo}) => {
            this._swarmConnection.reportPotentialPeer({nodeId: peerId, nodeInfo: peerNodeInfo});
        });

        // Start the loop
        this._start();
    }
    setNodeInfo(nodeInfo) {
        this._nodeInfo = nodeInfo;
        this._peerDiscoveryEngine.setNodeInfo(nodeInfo);
        this._swarmConnection.setNodeInfo(nodeInfo);
    }
    // Set an incoming websocket connection for a peer
    setIncomingPeerWebsocketConnection(peerId, connection) {
        this._swarmConnection.setIncomingPeerWebsocketConnection(peerId, connection);
    }
    // Set an incoming udp connection for a peer
    setIncomingPeerUdpConnection(peerId, connection) {
        this._swarmConnection.setIncomingPeerUdpConnection(peerId, connection);
    }
    // The number of peers
    numPeers = () => {
        return this._swarmConnection.peerIds().length;
    }
    // Sorted list of peer ids
    peerIds = () => {
        return this._swarmConnection.peerIds();
    }
    // Send a request to the swarm to find a file or a live feed
    // Returns: {onFound, onFinished, cancel}
    findFileOrLiveFeed = ({fileKey, timeoutMsec=4000}) => {
        return this._findFileOrLiveFeed({fileKey, timeoutMsec});
    }
    // Download a file (or part of a file) from a particular node in the swarm
    // returns {stream, cancel}
    downloadFile = async ({nodeId, fileKey, startByte, endByte, opts}) => {
        return await this._downloadFile({nodeId, fileKey, startByte, endByte, opts});
    }
    // Get live feed signed messages
    // Returns list of signed messages
    getLiveFeedSignedMessages = async ({nodeId, feedId, subfeedName, position, waitMsec, opts}) => {
        return await this._getLiveFeedSignedMessages({nodeId, feedId, subfeedName, position, waitMsec, opts});
    }
    // Submit messages to a live feed on a remote node
    submitMessagesToLiveFeed = async ({nodeId, feedId, subfeedName, messages}) => {
        return await this._submitMessagesToLiveFeed({nodeId, feedId, subfeedName, messages});
    }
    async leave() {
        this._halt = true;
        await this._swarmConnection.leave();
    }

    // IMPLEMENTATION ///////////////////////////////////////////////////
    _findFileOrLiveFeed = ({fileKey, timeoutMsec=4000}) => {
        const onFoundCallbacks = [];
        const onFinishedCallbacks = [];
        let isFinished = false;
        const listener = this._swarmConnection.createPeerMessageListener(
            (fromNodeId, msg) => {
                return ((msg.type === 'providing') && (fileKeysMatch(msg.fileKey, fileKey)));
            }
        );
        const handleCancel = () => {
            if (isFinished) return;
            isFinished = true;
            onFinishedCallbacks.forEach(cb => cb());
        }
        const ret = {
            onFound: cb => {onFoundCallbacks.push(cb)},
            onFinished: cb => {onFinishedCallbacks.push(cb)},
            cancel: handleCancel
        }
        this._swarmConnection.sendMessageToAllPeers({
            type: 'seeking',
            fileKey
        });
        listener.onMessage((fromNodeId, msg) => {
            if (fromNodeId !== msg.nodeId) {
                log().warning(`UNEXPECTED: msg.nodeId is not the same as fromNodeId`, {nodeId: msg.nodeId, fromNodeId});
                return;
            }
            if (this._channelName !== msg.channel) {
                log().warning(`UNEXPECTED: msg.channel is not the same as this._channelName`, {msgChannel: msg.channel, channelName: this._channelName});
                return;
            }
            const result = {
                channel: msg.channel,
                nodeId: msg.nodeId,
                fileKey: msg.fileKey,
                fileInfo: msg.fileInfo
            }
            onFoundCallbacks.forEach(cb => {cb(result);});
        });
        setTimeout(() => {
            handleCancel();
        }, timeoutMsec);
        ret.onFinished(() => {
            listener.cancel();
        })
        return ret;
    }
    _downloadFile = async ({nodeId, fileKey, startByte, endByte, opts}) => {
        const numBytes = endByte - startByte;

        const chunkSize = 4000000;
        const numChunks = Math.ceil(numBytes / chunkSize);
        let sha1_sum = crypto.createHash('sha1');

        const streamState = {
            readyToWrite: false,
            readyToWriteCallback: null
        }
        const stream = new Stream.Readable({
            read(size) {
                if (!streamState.readyToWrite) {
                    streamState.readyToWrite = true;
                    if (streamState.readyToWriteCallback) {
                        streamState.readyToWriteCallback();
                    }
                }
            }
        });

        const _waitForStreamReadyToWrite = async () => {
            if (streamState.readyToWrite)
                return;
            return new Promise((resolve, reject) => {
                streamState.readyToWriteCallback = resolve;
            });
        }

        let _currentReq = null;
        let _cancelled = false;
        const _handleCancel = () => {
            if (_cancelled) return;
            _cancelled = true;
            if (_currentReq) {
                _currentReq.cancel();
            }
        }

        const downloadChunk = async (chunkNum) => {
            return new Promise((resolve, reject) => {
                const chunkStartByte = startByte + chunkNum * chunkSize;
                const chunkEndByte = Math.min(chunkStartByte + chunkSize, endByte);
                const requestBody = {
                    type: 'downloadFile',
                    fileKey: fileKey,
                    startByte: chunkStartByte,
                    endByte: chunkEndByte
                };
                let finished = false;
                let bytesDownloadedThisChunk = 0;
        
                const req = this._swarmConnection.makeRequestToPeer(nodeId, requestBody, {timeout: 10000});
                _currentReq = req;
                req.onResponse(responseBody => {
                    if (finished) return;
                    if (!responseBody.data_b64) {
                        finished = true;
                        reject('Error downloading file. No data_b64 in response');
                        return;
                    }
                    try {
                        const buf = Buffer.from(responseBody.data_b64, 'base64');
                        sha1_sum.update(buf);
                        // todo: implement this properly so we don't overflow the stream
                        bytesDownloadedThisChunk += buf.length;
                        stream.push(buf);
                        streamState.readyToWrite = false;
                    }
                    catch(err) {
                        finished = true;
                        reject('Problem downloading data: ' + err.message);
                    }
                });
                req.onError(errorString => {
                    if (finished) return;
                    finished = true;
                    reject(Error(errorString));
                    return;
                })
                req.onFinished(() => {
                    if (finished) return;
                    finished = true;
                    if (bytesDownloadedThisChunk != chunkEndByte - chunkStartByte) {
                        reject(`Unexpected number of bytes for this chunk: ${bytesDownloadedThisChunk} <> ${chunkEndByte - chunkStartByte}`);
                        return;
                    }
                    resolve();
                    _currentReq = null;
                });
            });
        }

        const downloadChunks = async () => {
            for (let chunkNum = 0; chunkNum < numChunks; chunkNum ++) {
                if (!_cancelled) {
                    await _waitForStreamReadyToWrite();
                    try {
                        await downloadChunk(chunkNum);
                    }
                    catch(err) {
                        log().warning(`Problem in downloadChunks`, {error: err.message});
                        _handleCancel();
                    }
                }
            }
            // todo: check the sha1_sum here (if not cancelled)
            stream.push(null);
        }
        downloadChunks();
        return {
            stream,
            cancel: _handleCancel
        }
    }
    _getLiveFeedSignedMessages = async ({nodeId, feedId, subfeedName, position, waitMsec, opts}) => {
        return new Promise((resolve, reject) => {
            log().info('getLiveFeedSignedMessages', {nodeId, feedId, subfeedName, position, waitMsec, opts});
            const requestBody = {
                type: 'getLiveFeedSignedMessages',
                feedId,
                subfeedName,
                position,
                waitMsec
            };
            let finished = false;
            const signedMessages = []
            const req = this._swarmConnection.makeRequestToPeer(nodeId, requestBody, {timeout: waitMsec + 10000});
            req.onResponse(responseBody => {
                if (finished) return;
                for (let signedMessage of (responseBody.signedMessages || [])) {
                    signedMessages.push(signedMessage);
                }
            });
            req.onError(errorString => {
                if (finished) return;
                finished = true;
                reject(Error(errorString));
                return;
            })
            req.onFinished(() => {
                if (finished) return;
                finished = true;
                resolve(signedMessages);
            });
        });
    }
    async _handlePeerSeeking(fromNodeId, msg) {
        const fileKey = msg.fileKey;
        if (fileKey.sha1) {
            const fileInfo = await getLocalFileInfo({fileKey});
            if (fileInfo) {
                if ('path' in fileInfo)
                    delete fileInfo['path'];
                await this._swarmConnection.sendMessageToPeer(
                    fromNodeId,
                    {
                        type: 'providing',
                        channel: this._channelName,
                        nodeId: this._nodeId,
                        fileKey,
                        fileInfo
                    }
                )
            }
        }
        else if (fileKey.feedId) {
            if (await this._feedManager.hasWriteableFeed({feedId: fileKey.feedId})) {
                await this._swarmConnection.sendMessageToPeer(
                    fromNodeId,
                    {
                        type: 'providing',
                        channel: this._channelName,
                        nodeId: this._nodeId,
                        fileKey
                    }
                )
            }
        }
    }
    _submitMessagesToLiveFeed = async ({nodeId, feedId, subfeedName, messages}) => {
        return new Promise((resolve, reject) => {
            const requestBody = {
                type: 'submitMessagesToLiveFeed',
                feedId,
                subfeedName,
                messages
            };
            let finished = false;
            const req = this._swarmConnection.makeRequestToPeer(nodeId, requestBody, {timeout: 10000});
            req.onResponse(responseBody => {
                if (finished) return;
                // not expecting a response
            });
            req.onError(errorString => {
                if (finished) return;
                finished = true;
                reject(Error(errorString));
                return;
            })
            req.onFinished(() => {
                if (finished) return;
                finished = true;
                resolve();
            });
        });
    }
    async _handlePeerRequest({fromNodeId, requestBody, onResponse, onError, onFinished}) {
        if (requestBody.type === 'downloadFile') {
            const fileInfo = await getLocalFileInfo({fileKey: requestBody.fileKey});
            const startByte = requestBody.startByte;
            const endByte = requestBody.endByte;
            if ((startByte === undefined) || (endByte === undefined) || (typeof(startByte) !== 'number') || (typeof(endByte) !== 'number')) {
                onError('Missing or incorrect fields in request: startByte, endByte.');
                return;
            }
            if (endByte <= startByte) {
                onError(`Expected startByte < endByte, but got: ${startByte} ${endByte}`);
                return;
            }
            const numBytes = endByte - startByte;
            if (numBytes > MAX_BYTES_PER_DOWNLOAD_REQUEST) {
                onError(`Too many bytes in single download request: ${numBytes} > ${MAX_BYTES_PER_DOWNLOAD_REQUEST}`);
                return;
            }
            if (fileInfo) {
                const fileSystemPath = fileInfo['path'];
                const readStream = fs.createReadStream(fileSystemPath, {start: requestBody.startByte, end: requestBody.endByte - 1 /* notice the -1 here */});
                readStream.on('data', data => {
                    onResponse({
                        data_b64: data.toString('base64')
                    });
                });
                readStream.on('end', () => {
                    onFinished();
                });
            }
            else {
                onError('Unable to find file.');
            }
        }
        else if (requestBody.type === 'getLiveFeedSignedMessages') {
            const {feedId, subfeedName, position, waitMsec} = requestBody;
            let signedMessages;
            try {
                signedMessages = await this._feedManager.getSignedMessages({
                    feedId, subfeedName, position, maxNumMessages: 10, waitMsec
                });
            }
            catch(err) {
                onError(`Error getting signed messages: ${err.message}`);
                return;
            }
            onResponse({
                signedMessages
            });
            onFinished();
        }
        else if (requestBody.type === 'submitMessagesToLiveFeed') {
            const {feedId, subfeedName, messages} = requestBody;
            try {
                await this._feedManager._submitMessagesToLiveFeedFromRemoteNode({
                    fromNodeId, feedId, subfeedName, messages
                });
            }
            catch(err) {
                onError(`Error submitting messages: ${err.message}`);
                return;
            }
            // mo response needed
            onFinished();
        }
    }
    async _getInfoText() {
        const lines = [];
        lines.push(`CHANNEL CONNECTION: ${this._channelName}`);
        lines.push(`self ${this._nodeId.slice(0, 6)}`);
        const peerIds = this._swarmConnection.peerIds();
        for (let peerId of peerIds) {
            const p = this._swarmConnection.peerConnection(peerId);
            const ci = p.peerNodeInfo() || {};
            const hasIn = p.hasIncomingWebsocketConnection();
            const hasOut = p.hasOutgoingWebsocketConnection();
            const hasUdpIn = p.hasIncomingUdpConnection();
            const hasUdpOut = p.hasOutgoingUdpConnection();
            const hasRoute = await this._swarmConnection.hasRouteToPeer(peerId);
            const items = [];
            if (hasIn) items.push('in');
            if (hasOut) items.push('out');
            if (hasUdpIn) items.push('udp-in');
            if (hasUdpOut) items.push('udp-out');
            if (hasRoute) items.push('route');
            lines.push(`Peer ${peerId.slice(0, 6)}... ${ci.label}: ${ci.host || ""}:${ci.port || ""} ${ci.local ? "(local)" : ""} ${items.join(' ')}`);
        }
        return lines.join('\n');
    }
    async _start() {
        let lastInfoText = '';
        while (true) {
            if (this._halt) return;
            const infoText = await this._getInfoText();
            if (infoText !== lastInfoText) {
                console.info('****************************************************************');
                console.info(infoText);
                console.info('****************************************************************');
                lastInfoText = infoText;
            }
            await sleepMsec(100);
        }
    }
}

const fileKeysMatch = (k1, k2) => {
    if (k1.sha1) {
        return k1.sha1 === k2.sha1;
    }
    else if (k1.type === 'liveFeed') {
        return ((k1.type === k2.type) && (k1.feedId === k2.feedId));
    }
    else {
        return false;
    }
}

export default KacheryChannelConnection;