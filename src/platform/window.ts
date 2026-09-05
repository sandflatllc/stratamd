/** Pure options so platform branching stays out of the window lifecycle and UI. */
export function windowChrome(platform: string = process.platform): 'custom' | 'traffic-lights' | 'native' {
  return platform === 'linux' ? 'custom' : platform === 'darwin' ? 'traffic-lights' : 'native'
}

export function windowFrameOptions(platform: string = process.platform) {
  return {
    frame: platform !== 'linux',
    ...(platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 20 } } : {})
  }
}
