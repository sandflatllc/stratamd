const { writeFileSync } = require('node:fs')
module.exports = class TimingReporter {
  constructor() { this.firstTest = null; this.lastTest = null }
  onTestBegin() { this.firstTest ??= Date.now() }
  onTestEnd() { this.lastTest = Date.now() }
  onEnd() {
    if (process.env.STRATAMD_VERIFY_ELECTRON_TIMING) writeFileSync(process.env.STRATAMD_VERIFY_ELECTRON_TIMING, JSON.stringify({ firstTest: this.firstTest, lastTest: this.lastTest }))
  }
}
