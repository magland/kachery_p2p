import { byteCount, ByteCount, byteCountToNumber } from "../interfaces/core"

export interface DataStreamyProgress {
    bytesLoaded: ByteCount
    bytesTotal: ByteCount
}

class DataStreamyProducer {
    #cancelled = false
    #onCancelledCallbacks: (() => void)[] = []
    #lastUnorderedDataIndex: number = -1
    #unorderedDataChunksByIndex = new Map<number, Buffer>()
    #unorderedEndNumDataChunks: number | null = null
    constructor(private dataStream: DataStreamy) {
    }
    onCancelled(cb: () => void) {
        if (this.#cancelled) {
            cb()
        }
        this.#onCancelledCallbacks.push(cb)
    }
    error(err: Error) {
        if (this.#cancelled) return
        this.dataStream._producer_error(err)
    }
    start(size: ByteCount | null) {
        if (this.#cancelled) return
        this.dataStream._producer_start(size)
    }
    end() {
        if (this.#cancelled) return
        this.dataStream._producer_end()
    }
    data(buf: Buffer) {
        if (this.#cancelled) return
        this.dataStream._producer_data(buf)
    }
    unorderedData(index: number, buf: Buffer) {
        this.#unorderedDataChunksByIndex.set(index, buf)
        while (this.#unorderedDataChunksByIndex.has(this.#lastUnorderedDataIndex + 1)) {
            this.#lastUnorderedDataIndex ++
            const buf = this.#unorderedDataChunksByIndex.get(this.#lastUnorderedDataIndex)
            if (!buf) {
                /* istanbul ignore next */
                throw Error('unexpected')
            }
            this.#unorderedDataChunksByIndex.delete(this.#lastUnorderedDataIndex)
            this.data(buf)
            if (this.#unorderedEndNumDataChunks !== null) {
                if (this.#lastUnorderedDataIndex === this.#unorderedEndNumDataChunks - 1) {
                    this.end()
                }
                else if (this.#lastUnorderedDataIndex > this.#unorderedEndNumDataChunks - 1) {
                    throw Error('Unexpected lastUnorderedDataIndex')
                }
            }
        }
    }
    unorderedEnd(numDataChunks: number) {
        if (this.#lastUnorderedDataIndex >= numDataChunks - 1) {
            this.end()
        }
        else {
            this.#unorderedEndNumDataChunks = numDataChunks
        }
    }
    incrementBytes(numBytes: ByteCount) {
        if (this.#cancelled) return
        this.dataStream._producer_incrementBytes(numBytes)
    }
    reportBytesLoaded(numBytes: ByteCount) {
        if (this.#cancelled) return
        this.dataStream._producer_reportBytesLoaded(numBytes)
    }
    _cancel() {
        if (this.#cancelled) return
        this.#cancelled = true
        this.#onCancelledCallbacks.forEach(cb => {cb()})
        this.dataStream._producer_error(Error('Cancelled'))
    }
}

export default class DataStreamy {
    #producer: DataStreamyProducer

    // state
    #completed = false
    #finished = false
    #started = false
    #size: ByteCount | null = null
    #bytesLoaded: ByteCount = byteCount(0)
    #error: Error | null = null
    #pendingDataChunks: Buffer[] = []

    // callbacks
    #onStartedCallbacks: ((size: ByteCount | null) => void)[] = []
    #onDataCallbacks: ((data: Buffer) => void)[] = []
    #onFinishedCallbacks: (() => void)[] = []
    #onCompleteCallbacks: (() => void)[] = []
    #onErrorCallbacks: ((err: Error) => void)[] = []
    #onProgressCallbacks: ((progress: DataStreamyProgress) => void)[] = []

    constructor() {
        this.#producer = new DataStreamyProducer(this)
    }
    onStarted(callback: ((size: ByteCount | null) => void)) {
        if (this.#started) {
            callback(this.#size)
        }
        this.#onStartedCallbacks.push(callback)
    }
    onData(callback: ((data: Buffer) => void)) {
        if ((this.#onDataCallbacks.length > 0) && (byteCountToNumber(this.#bytesLoaded) > 0)) {
            throw Error('onData already called in DataStreamy, and we have already received data')
        }
        this.#pendingDataChunks.forEach((ch: Buffer) => {
            callback(ch)
        })
        this.#pendingDataChunks = []
        this.#onDataCallbacks.push(callback)
    }
    async allData(): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const buffers: Buffer[] = []
            this.onData(buf => buffers.push(buf))
            this.onFinished(() => {
                resolve(Buffer.concat(buffers))
            })
            this.onError((err) => {
                reject(err)
            })
        })
    }
    onFinished(callback: (() => void)) {
        if (this.#finished) {
            callback()
        }
        this.#onFinishedCallbacks.push(callback)
    }
    onError(callback: ((err: Error) => void)) {
        if (this.#error) {
            callback(this.#error)
        }
        this.#onErrorCallbacks.push(callback)
    }
    onComplete(callback: (() => void)) {
        if ((this.#completed)) {
            callback()
        }
        this.#onCompleteCallbacks.push(callback)
    }
    onProgress(callback: (progress: DataStreamyProgress) => void) {
        if ((byteCountToNumber(this.#bytesLoaded) > 0) && (this.#size)) {
            callback({bytesLoaded: this.#bytesLoaded, bytesTotal: this.#size})
        }
        this.#onProgressCallbacks.push(callback)
    }
    bytesLoaded(): ByteCount {
        return this.#bytesLoaded
    }
    cancel() {
        this.#producer._cancel()
    }
    isComplete() {
        return this.#completed
    }
    producer() {
        return this.#producer
    }
    _producer_error(err: Error) {
        if (this.#completed) return
        this.#completed = true
        this.#error = err
        this.#onErrorCallbacks.forEach(cb => {cb(err)})
        this._handle_complete()
    }
    _producer_start(size: ByteCount | null) {
        if (this.#completed) return
        if (this.#started) return
        this.#started = true
        this.#size = size
        this.#onStartedCallbacks.forEach(cb => {
            cb(size)
        })
    }
    _producer_end() {
        if (this.#completed) return
        this.#completed = true
        this.#finished = true
        this.#onFinishedCallbacks.forEach(cb => {cb()})
        this._handle_complete()
    }
    _handle_complete() {
        this.#onCompleteCallbacks.forEach(cb => {cb()})
        if (this.#pendingDataChunks.length > 0) {
            setTimeout(() => {
                this.#pendingDataChunks = []
            }, 1000)
        }
    }
    _producer_data(buf: Buffer) {
        if (this.#completed) return
        if (!this.#started) {
            this.#started = true
            this.#onStartedCallbacks.forEach(cb => {
                cb(null)
            })
        }
        this.#onDataCallbacks.forEach(cb => {
            cb(buf)
        })
        this._producer_incrementBytes(byteCount(buf.length))
        if (this.#onDataCallbacks.length === 0) {
            this.#pendingDataChunks.push(buf)
        }
    }
    _producer_incrementBytes(numBytes: ByteCount) {
        this._producer_reportBytesLoaded(byteCount(byteCountToNumber(this.#bytesLoaded) + byteCountToNumber(numBytes)))
    }
    _producer_reportBytesLoaded(numBytes: ByteCount) {
        this.#bytesLoaded = numBytes
        const s = this.#size
        if (s !== null) {
            this.#onProgressCallbacks.forEach(cb => {
                cb({bytesLoaded: this.#bytesLoaded, bytesTotal: s})
            })
        }
    }
}