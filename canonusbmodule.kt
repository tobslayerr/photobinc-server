package com.photobincapp

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.facebook.react.bridge.*
import com.photobincapp.ptp.usbcamera.Data
import com.photobincapp.ptp.usbcamera.Response
import com.photobincapp.ptp.usbcamera.eos.EosInitiator
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import android.util.Log

class CanonUsbModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val ACTION_USB_PERMISSION = "com.photobincapp.USB_PERMISSION"
    }

    private val usbManager = reactContext.getSystemService(Context.USB_SERVICE) as UsbManager
    private var eosCamera: EosInitiator? = null
    private var pendingPromise: Promise? = null
    private val usbLock = Any()

    @Volatile
    private var isLiveViewRunning = false
    private var liveViewThread: Thread? = null
    private var mjpegServer: MjpegServer? = null

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val action = intent.action

            // 1. KETIKA POP-UP DI-IZINKAN
            if (ACTION_USB_PERMISSION == action) {
                synchronized(this) {
                    val device: UsbDevice? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                    }

                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted && device != null) {
                        Thread { Thread.sleep(800); try { openCameraConnection(device, pendingPromise) } catch (e: Exception) { pendingPromise = null } }.start()
                    } else {
                        pendingPromise?.reject("DENIED", "Izin ditolak.")
                        pendingPromise = null
                    }
                }
            }
            // 2. 🚀 KETIKA KAMERA DIMATIKAN / KABEL DICABUT FISIK (BUNUH ZOMBIE)
            else if (UsbManager.ACTION_USB_DEVICE_DETACHED == action) {
                synchronized(usbLock) {
                    isLiveViewRunning = false
                    try { mjpegServer?.stopStream() } catch(e: Exception){}
                    eosCamera = null
                    Log.d("CanonUsb", "Kamera terputus secara fisik!")
                }
            }
        }
    }

    init {
        val filter = IntentFilter()
        filter.addAction(ACTION_USB_PERMISSION)
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED) // 🚀 DAFTARKAN PENDENGAR CABUT USB

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(usbReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            reactContext.registerReceiver(usbReceiver, filter)
        }
        mjpegServer = MjpegServer(8080)
        tryAutoConnectOnStartup()
    }

    override fun getName(): String { return "CanonUsbModule" }

    private fun tryAutoConnectOnStartup() {
        Thread {
            try {
                for (device in usbManager.deviceList.values) {
                    if (device.vendorId == 1193 || isPtpDevice(device)) {
                        if (usbManager.hasPermission(device)) openCameraConnection(device, null)
                        break
                    }
                }
            } catch (e: Exception) {}
        }.start()
    }

    @ReactMethod
    fun connectCamera(promise: Promise) {
        synchronized(usbLock) {
            if (eosCamera != null) { promise.resolve("Terhubung"); return } // <-- Jika nyangkut, ini yang menggagalkan pop-up
            try {
                val deviceList = usbManager.deviceList
                var targetDevice: UsbDevice? = null
                for (device in deviceList.values) { if (device.vendorId == 1193 || isPtpDevice(device)) { targetDevice = device; break } }

                if (targetDevice == null) { promise.reject("NO", "Tidak ada kamera."); return }

                if (!usbManager.hasPermission(targetDevice)) {
                    pendingPromise = promise
                    val intent = Intent(ACTION_USB_PERMISSION).setPackage(reactApplicationContext.packageName)
                    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) { PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT } else { PendingIntent.FLAG_UPDATE_CURRENT }
                    usbManager.requestPermission(targetDevice, PendingIntent.getBroadcast(reactApplicationContext, 0, intent, flags))
                    return
                }

                Thread { Thread.sleep(300); openCameraConnection(targetDevice, promise) }.start()
            } catch (e: Exception) { promise.reject("ERR", e.message) }
        }
    }

    // 🚀 FUNGSI BARU UNTUK HARD RESET DARI APP.TSX
    @ReactMethod
    fun disconnectCamera(promise: Promise) {
        synchronized(usbLock) {
            try {
                isLiveViewRunning = false
                try { mjpegServer?.stopStream() } catch(e: Exception){}
                eosCamera = null // BUNUH ZOMBIE DISINI
                promise.resolve("Terputus")
            } catch (e: Exception) {
                eosCamera = null
                promise.resolve("Paksa Terputus")
            }
        }
    }

    private fun isPtpDevice(device: UsbDevice): Boolean {
        for (i in 0 until device.interfaceCount) { if (device.getInterface(i).interfaceClass == 6) return true }
        return false
    }

    private fun openCameraConnection(device: UsbDevice, promise: Promise?) {
        synchronized(usbLock) {
            try {
                val connection = usbManager.openDevice(device)
                eosCamera = EosInitiator(device, connection)
                eosCamera?.syncTriggerMode = 999
                eosCamera?.openSession()
                Thread.sleep(600)
                promise?.resolve("Terhubung")
            } catch (e: Exception) { eosCamera = null } finally { pendingPromise = null }
        }
    }

    private fun extractCanonLiveViewJpeg(data: ByteArray): ByteArray? {
        if (data.size <= 12) return null
        try {
            val buffer = ByteBuffer.wrap(data, 12, data.size - 12).order(ByteOrder.LITTLE_ENDIAN)
            while (buffer.remaining() >= 8) {
                val len = buffer.int
                val type = buffer.int
                if (len < 8) break
                val payloadLen = len - 8
                if (payloadLen > buffer.remaining()) break
                if (type == 1 || type == 9 || type == 11) {
                    val segData = ByteArray(payloadLen)
                    buffer.get(segData)
                    val jpeg = extractJpegMarkers(segData)
                    if (jpeg != null) return jpeg
                } else buffer.position(buffer.position() + payloadLen)
            }
        } catch (e: Exception) {}
        return extractJpegMarkers(data)
    }

    private fun extractJpegMarkers(data: ByteArray): ByteArray? {
        var start = -1
        for (i in 0 until data.size - 1) { if (data[i] == 0xFF.toByte() && data[i + 1] == 0xD8.toByte()) { start = i; break } }
        if (start < 0) return null
        for (i in start + 2 until data.size - 1) { if (data[i] == 0xFF.toByte() && data[i + 1] == 0xD9.toByte()) return data.copyOfRange(start, i + 2) }
        return null
    }

    @ReactMethod
    fun startLiveView(promise: Promise) {
        val camera = eosCamera
        if (camera == null) { promise.reject("NO", "Kamera belum terhubung."); return }
        if (isLiveViewRunning) { promise.resolve("OK"); return }

        isLiveViewRunning = true
        mjpegServer?.startStream()

        liveViewThread = Thread {
            try {
                synchronized(usbLock) {
                    try { camera.checkEvents() } catch(e: Exception){}
                    try { camera.transact1(0x9114, null, 1) } catch(e: Exception){}
                    try { camera.transact1(0x9115, null, 1) } catch(e: Exception){}
                    try { camera.setDevicePropValueEx(0xD1B1, 1) } catch(e: Exception){}
                    try { camera.setDevicePropValueEx(0xD1B0, 2) } catch(e: Exception){}
                    try { camera.transact0(0x911D, null) } catch(e: Exception){}
                }

                var param = 0x00200000

                while (isLiveViewRunning) {
                    var jpegBytes: ByteArray? = null

                    synchronized(usbLock) {
                        if (!isLiveViewRunning) return@synchronized

                        try {
                            try { camera.checkEvents() } catch(e: Exception){}
                            val dataContainer = Data(camera)
                            var response = camera.transact3(0x9153, dataContainer, param, 0, 0)

                            if (response.getCode() == Response.ParameterNotSupported || response.getCode() == 0x2005) {
                                param = if (param == 0x00200000) 0x00100000 else 0
                                response = if (param != 0) camera.transact3(0x9153, dataContainer, param, 0, 0) else camera.transact0(0x9153, dataContainer)
                            }

                            if (response.getCode() == Response.OK) {
                                val rawData = dataContainer.data
                                if (rawData != null && rawData.size > 12) {
                                    jpegBytes = extractCanonLiveViewJpeg(rawData)
                                }
                            }
                        } catch (e: Exception) {}
                    }

                    if (jpegBytes != null) {
                        mjpegServer?.updateFrame(jpegBytes)
                    }

                    // 🚀 PERBAIKAN FATAL: Membuka kunci kecepatan FPS.
                    // Mengubah sleep dari 50ms (memaksa max 15 FPS) menjadi 15ms.
                    // 15ms sudah cukup memberi nafas pada CPU HP, namun tetap
                    // mengizinkan streaming berjalan mulus di kisaran 30 - 45 FPS!
                    Thread.sleep(15)
                }
            } catch (e: Exception) {
            } finally {
                synchronized(usbLock) {
                    try { eosCamera?.setDevicePropValueEx(0xD1B0, 0) } catch(e: Exception){}
                    try { eosCamera?.setDevicePropValueEx(0xD1B1, 0) } catch(e: Exception){}
                }
            }
        }.apply { start() }
        promise.resolve("Live View dimulai")
    }

    @ReactMethod
    fun stopLiveView(promise: Promise) {
        isLiveViewRunning = false
        Thread {
            try { liveViewThread?.join(3000) } catch (e: Exception) {}
            try { mjpegServer?.stopStream() } catch (e: Exception) {}

            synchronized(usbLock) {
                try { eosCamera?.setDevicePropValueEx(0xD1B0, 0) } catch (e: Exception) {}
                try { eosCamera?.setDevicePropValueEx(0xD1B1, 0) } catch (e: Exception) {}
            }
            promise.resolve("OK")
        }.start()
    }

    @ReactMethod
    fun captureImage(promise: Promise) {
        val camera = eosCamera
        if (camera == null) { promise.reject("NO", "Kamera belum terhubung."); return }

        Thread {
            synchronized(usbLock) {
                try {
                    Thread.sleep(600)
                    val storageIds = camera.getStorageIds()
                    val sdCardId = if (storageIds != null && storageIds.isNotEmpty()) storageIds[0] else 0
                    val oldHandles = camera.getObjectHandles(sdCardId, 0, 0) ?: IntArray(0)
                    val oldDeep = camera.getObjectHandles(sdCardId, 0, -1) ?: IntArray(0)
                    val combinedOld = (oldHandles.toList() + oldDeep.toList()).distinct().toMutableList()
                    Thread.sleep(300)

                    try { camera.setDevicePropValueEx(0xD11C, 2) } catch (e: Exception) {}
                    try { camera.initiateCapture(sdCardId, 0) } catch (e: Exception) {}

                    val cacheDir = reactApplicationContext.cacheDir
                    val startTime = System.currentTimeMillis()
                    var bestFile: File? = null
                    var isCaptureDone = false

                    while (System.currentTimeMillis() - startTime < 25000L) {
                        Thread.sleep(800)
                        try { camera.checkEvents() } catch (e: Exception) {}

                        val cur = camera.getObjectHandles(sdCardId, 0, 0) ?: IntArray(0)
                        val deep = camera.getObjectHandles(sdCardId, 0, -1) ?: IntArray(0)
                        val added = (cur.toList() + deep.toList()).distinct().filter { !combinedOld.contains(it) }

                        if (added.isEmpty()) continue

                        for (handle in added.reversed()) {
                            combinedOld.add(handle)
                            val size = try { camera.getObjectInfo(handle)?.objectCompressedSize ?: 0 } catch (e: Exception) { 0 }

                            if (size > 500000L) {
                                val tempFile = File(cacheDir, "temp_${System.currentTimeMillis()}_$handle.jpg")
                                val success = try { camera.importFile(handle, tempFile.absolutePath) } catch (ex: Exception) { false }
                                if (success && tempFile.exists()) { bestFile?.delete(); bestFile = tempFile; isCaptureDone = true } else tempFile.delete()
                            }
                            try { camera.transferComplete(handle) } catch (e: Exception) {}
                        }
                        if (isCaptureDone) break
                    }

                    if (bestFile != null && bestFile.exists()) {
                        val base64Str = android.util.Base64.encodeToString(bestFile.readBytes(), android.util.Base64.NO_WRAP)
                        promise.resolve("data:image/jpeg;base64,$base64Str")
                        bestFile.delete()
                    } else promise.reject("ERR", "Gagal tarik foto.")
                } catch (e: Exception) { promise.reject("ERR", e.message) }
            }
        }.start()
    }
}