import { DaemonVersion, ProtocolVersion } from './interfaces/core';

const PROTOCOL_VERSION = 'kachery-p2p-0.5.8';
const DAEMON_VERSION = 'kachery-p2p-0.5.8';

export const protocolVersion = (): ProtocolVersion => {
    return PROTOCOL_VERSION as any as ProtocolVersion;
}

export const daemonVersion = (): DaemonVersion => {
    return DAEMON_VERSION as any as DaemonVersion;
}