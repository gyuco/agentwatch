import { readFileSync, watch, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function ingestExisting(collector, queuePath) {
  let lastOffset = 0
  try {
    const data = readFileSync(queuePath, 'utf8')
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      try {
        collector.ingest(JSON.parse(line))
      } catch {}
    }
    lastOffset = data.length
  } catch {}
  return lastOffset
}

export function attachQueueWatcher({ queuePath, collector, onRecord, pollMs = 2000 }) {
  try {
    mkdirSync(dirname(queuePath), { recursive: true })
  } catch {}

  let pending = ingestExisting(collector, queuePath)
  let watcher = null

  const flush = () => {
    try {
      const data = readFileSync(queuePath, 'utf8')
      if (data.length > pending) {
        const newPart = data.slice(pending)
        pending = data.length
        for (const line of newPart.split('\n')) {
          if (!line.trim()) continue
          try {
            const record = collector.ingest(JSON.parse(line))
            if (record && onRecord) onRecord(record)
          } catch {}
        }
      } else if (data.length < pending) {
        pending = 0
      }
    } catch {}
  }

  try {
    watcher = watch(dirname(queuePath), (_event, filename) => {
      if (!filename || String(filename).endsWith('events.ndjson')) flush()
    })
  } catch {}

  const poll = setInterval(flush, pollMs)
  poll.unref()

  return {
    close() {
      try {
        clearInterval(poll)
        if (watcher) watcher.close()
      } catch {}
    }
  }
}