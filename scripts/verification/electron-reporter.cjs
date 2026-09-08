const { writeFileSync } = require('node:fs')
module.exports = class TimingReporter {
  constructor() { this.firstTest = null; this.lastTest = null }
  progress(event, test) {
    if (process.env.STRATAMD_VERIFY_ELECTRON_PROGRESS) writeFileSync(process.env.STRATAMD_VERIFY_ELECTRON_PROGRESS, JSON.stringify({ at: Date.now(), event, test: test?.title }))
  }
  onBegin() { this.progress('suite') }
  onTestBegin(test) { this.firstTest ??= Date.now(); this.progress('test-begin', test) }
  onTestEnd(test) { this.lastTest = Date.now(); this.progress('test-end', test) }
  onEnd() {
    this.progress('suite-end')
    if (process.env.STRATAMD_VERIFY_ELECTRON_TIMING) writeFileSync(process.env.STRATAMD_VERIFY_ELECTRON_TIMING, JSON.stringify({ firstTest: this.firstTest, lastTest: this.lastTest }))
  }
}
