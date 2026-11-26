package com.photobincapp

import android.util.Log
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.ArrayBlockingQueue

class MjpegServer(port: Int) : NanoHTTPD(port) {
    private var mjpegInputStream: MjpegInputStream? = null

    fun startStream() {
        mjpegInputStream = MjpegInputStream()
        if (!isAlive) start(SOCKET_READ_TIMEOUT, false)
    }

    fun stopStream() {
        mjpegInputStream?.stop()
        mjpegInputStream = null
        if (isAlive) stop()
    }

    fun updateFrame(jpegBytes: ByteArray) {
        mjpegInputStream?.pushFrame(jpegBytes)
    }

    override fun serve(session: IHTTPSession): Response {
        if (session.uri == "/liveview.mjpg") {
            if (mjpegInputStream == null) return newFixedLengthResponse(Response.Status.SERVICE_UNAVAILABLE, MIME_PLAINTEXT, "Wait")
            val response = newChunkedResponse(Response.Status.OK, "multipart/x-mixed-replace; boundary=--BoundaryString", mjpegInputStream)
            response.addHeader("Access-Control-Allow-Origin", "*") // 🚀 WAJIB UNTUK WEBVIEW
            response.addHeader("Cache-Control", "no-cache, no-store, must-revalidate")
            response.addHeader("Connection", "close")
            return response
        }
        return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "404")
    }

    inner class MjpegInputStream : InputStream() {
        private val frameQueue = ArrayBlockingQueue<ByteArray>(2)
        private var currentStream: ByteArrayInputStream? = null
        @Volatile private var isRunning = true

        fun pushFrame(frame: ByteArray) {
            if (frameQueue.remainingCapacity() == 0) frameQueue.poll()
            frameQueue.offer(frame)
        }

        fun stop() {
            isRunning = false
            frameQueue.clear()
            frameQueue.offer(ByteArray(0))
        }

        override fun read(): Int {
            val b = ByteArray(1)
            val r = read(b, 0, 1)
            return if (r == -1) -1 else b[0].toInt() and 0xFF
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (!isRunning) return -1
            if (currentStream == null || currentStream!!.available() == 0) {
                val frame = try { frameQueue.take() } catch (e: Exception) { return -1 }
                if (!isRunning || frame.isEmpty()) return -1

                val boundary = "\r\n--BoundaryString\r\n".toByteArray()
                val contentType = "Content-Type: image/jpeg\r\n".toByteArray()
                val contentLength = "Content-Length: ${frame.size}\r\n\r\n".toByteArray()

                val fullData = ByteArray(boundary.size + contentType.size + contentLength.size + frame.size)
                var pos = 0
                System.arraycopy(boundary, 0, fullData, pos, boundary.size); pos += boundary.size
                System.arraycopy(contentType, 0, fullData, pos, contentType.size); pos += contentType.size
                System.arraycopy(contentLength, 0, fullData, pos, contentLength.size); pos += contentLength.size
                System.arraycopy(frame, 0, fullData, pos, frame.size)

                currentStream = ByteArrayInputStream(fullData)
            }
            return currentStream!!.read(b, off, len)
        }
    }
}