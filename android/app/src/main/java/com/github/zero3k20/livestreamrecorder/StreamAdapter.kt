package com.github.zero3k20.livestreamrecorder

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.RecyclerView
import com.github.zero3k20.livestreamrecorder.models.DownloadState
import com.github.zero3k20.livestreamrecorder.models.StreamInfo
import com.google.android.material.button.MaterialButton

class StreamAdapter(
    private val onRecord: (StreamInfo) -> Unit,
    private val onStop: (StreamInfo) -> Unit
) : RecyclerView.Adapter<StreamAdapter.ViewHolder>() {

    private var streams: List<StreamInfo>             = emptyList()
    private var downloadStates: Map<String, DownloadState> = emptyMap()

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val tvType: TextView        = view.findViewById(R.id.tvStreamType)
        val tvUrl: TextView         = view.findViewById(R.id.tvStreamUrl)
        val tvStatus: TextView      = view.findViewById(R.id.tvStatus)
        val progressBar: ProgressBar = view.findViewById(R.id.progressBar)
        val btnRecord: MaterialButton = view.findViewById(R.id.btnRecord)
        val btnStop: MaterialButton   = view.findViewById(R.id.btnStop)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_stream_detected, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val stream = streams[position]
        val state  = downloadStates[stream.id]
        val ctx    = holder.itemView.context

        holder.tvType.text = stream.type.uppercase()

        // Truncate long URLs from the middle to keep the host and path visible
        holder.tvUrl.text = truncateUrl(stream.url, 70)

        // Type-badge tint
        val tintRes = when (stream.type.lowercase()) {
            "hls"       -> R.color.badge_hls
            "flv"       -> R.color.badge_flv
            "mp4"       -> R.color.badge_mp4
            "webm"      -> R.color.badge_webm
            "websocket" -> R.color.badge_ws
            else        -> R.color.badge_direct
        }
        holder.tvType.setBackgroundColor(ctx.getColor(tintRes))

        when (state) {
            is DownloadState.Downloading -> {
                holder.btnRecord.visibility = View.GONE
                holder.btnStop.visibility   = View.VISIBLE
                holder.progressBar.visibility = View.VISIBLE
                holder.tvStatus.visibility  = View.VISIBLE
                holder.tvStatus.setTextColor(ctx.getColor(R.color.status_neutral))

                val mb = state.bytesDownloaded / (1024 * 1024)
                holder.tvStatus.text = if (state.totalSegments > 0) {
                    "Segment ${state.segmentsCompleted}/${state.totalSegments} · $mb MB"
                } else if (state.totalBytes > 0) {
                    val pct = (state.bytesDownloaded * 100 / state.totalBytes).toInt()
                    holder.progressBar.progress = pct
                    "$mb MB / ${state.totalBytes / (1024 * 1024)} MB ($pct%)"
                } else {
                    "Downloading… $mb MB"
                }
            }
            is DownloadState.Completed -> {
                holder.btnRecord.visibility   = View.VISIBLE
                holder.btnStop.visibility     = View.GONE
                holder.progressBar.visibility = View.GONE
                holder.tvStatus.visibility    = View.VISIBLE
                val mb = state.totalBytes / (1024 * 1024)
                holder.tvStatus.text = "✓ Saved · $mb MB"
                holder.tvStatus.setTextColor(ctx.getColor(R.color.status_success))
            }
            is DownloadState.Failed -> {
                holder.btnRecord.visibility   = View.VISIBLE
                holder.btnStop.visibility     = View.GONE
                holder.progressBar.visibility = View.GONE
                holder.tvStatus.visibility    = View.VISIBLE
                holder.tvStatus.text = "✗ ${state.error}"
                holder.tvStatus.setTextColor(ctx.getColor(R.color.status_error))
            }
            else -> {
                holder.btnRecord.visibility   = View.VISIBLE
                holder.btnStop.visibility     = View.GONE
                holder.tvStatus.visibility    = View.GONE
                holder.progressBar.visibility = View.GONE
            }
        }

        holder.btnRecord.setOnClickListener { onRecord(stream) }
        holder.btnStop.setOnClickListener   { onStop(stream) }
    }

    override fun getItemCount(): Int = streams.size

    fun updateStreams(newStreams: List<StreamInfo>) {
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize() = streams.size
            override fun getNewListSize() = newStreams.size
            override fun areItemsTheSame(oldPos: Int, newPos: Int) =
                streams[oldPos].id == newStreams[newPos].id
            override fun areContentsTheSame(oldPos: Int, newPos: Int) =
                streams[oldPos] == newStreams[newPos]
        })
        streams = newStreams
        diff.dispatchUpdatesTo(this)
    }

    fun updateDownloadStates(newStates: Map<String, DownloadState>) {
        downloadStates = newStates
        notifyItemRangeChanged(0, itemCount)
    }

    private fun truncateUrl(url: String, maxLen: Int): String {
        if (url.length <= maxLen) return url
        val half = maxLen / 2 - 1
        return url.take(half) + "…" + url.takeLast(half)
    }
}
