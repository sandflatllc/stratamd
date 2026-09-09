// Loaded only by Strata's Windows engine launch. The private parent IPC channel
// reaches the stock server's existing shutdown handlers without TerminateProcess.
let stopping = false
process.on('message', message => {
  if (stopping || message?.type !== 'strata:shutdown') return
  stopping = true
  process.emit('SIGTERM', 'SIGTERM')
})
// The transport must not keep the stock runtime alive after its shutdown finishes.
process.channel?.unref()
