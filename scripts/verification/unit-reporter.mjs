import { writeFileSync } from 'node:fs'
export default class RetryReporter {
  retried = []
  onTestCaseResult(test) {
    const diagnostic = test.diagnostic()
    if (diagnostic?.retryCount) this.retried.push({ name: test.fullName, file: test.module.moduleId, retries: diagnostic.retryCount })
  }
  onTestRunEnd() {
    if (process.env.STRATAMD_VERIFY_UNIT_RETRIES) writeFileSync(process.env.STRATAMD_VERIFY_UNIT_RETRIES, JSON.stringify(this.retried))
  }
}
