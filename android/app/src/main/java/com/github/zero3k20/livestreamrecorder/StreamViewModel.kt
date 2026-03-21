package com.github.zero3k20.livestreamrecorder

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.github.zero3k20.livestreamrecorder.download.DownloadManager
import com.github.zero3k20.livestreamrecorder.models.DownloadState
import com.github.zero3k20.livestreamrecorder.models.StreamInfo

/**
 * Shared ViewModel that holds the list of detected streams and their
 * download states.  The Activity and the bottom-sheet stream panel both
 * observe the same instance so UI updates are consistent.
 */
class StreamViewModel(application: Application) : AndroidViewModel(application) {

    private val _detectedStreams = MutableLiveData<List<StreamInfo>>(emptyList())
    val detectedStreams: LiveData<List<StreamInfo>> = _detectedStreams

    private val _downloadStates = MutableLiveData<Map<String, DownloadState>>(emptyMap())
    val downloadStates: LiveData<Map<String, DownloadState>> = _downloadStates

    private val downloadManager = DownloadManager(application)

    /** Deduplicate by URL so the same stream is never listed twice. */
    private val seenUrls = mutableSetOf<String>()

    fun addStream(url: String, type: String, pageUrl: String = "", pageTitle: String = "") {
        if (url.isBlank() || url in seenUrls) return
        seenUrls.add(url)
        val stream = StreamInfo(url = url, type = type, pageUrl = pageUrl, pageTitle = pageTitle)
        val current = _detectedStreams.value.orEmpty()
        _detectedStreams.postValue(current + stream)
    }

    fun startDownload(stream: StreamInfo) {
        updateDownloadState(stream.id, DownloadState.Downloading())
        downloadManager.startDownload(stream, object : DownloadManager.Callback {
            override fun onProgress(streamId: String, state: DownloadState.Downloading) {
                updateDownloadState(streamId, state)
            }
            override fun onComplete(streamId: String, state: DownloadState.Completed) {
                updateDownloadState(streamId, state)
            }
            override fun onError(streamId: String, error: String) {
                updateDownloadState(streamId, DownloadState.Failed(error))
            }
        })
    }

    fun stopDownload(streamId: String) {
        downloadManager.cancelDownload(streamId)
        updateDownloadState(streamId, DownloadState.Idle)
    }

    fun clearDetectedStreams() {
        downloadManager.cancelAll()
        seenUrls.clear()
        _detectedStreams.postValue(emptyList())
        _downloadStates.postValue(emptyMap())
    }

    private fun updateDownloadState(streamId: String, state: DownloadState) {
        val current = _downloadStates.value.orEmpty().toMutableMap()
        current[streamId] = state
        _downloadStates.postValue(current)
    }

    override fun onCleared() {
        super.onCleared()
        downloadManager.destroy()
    }
}
