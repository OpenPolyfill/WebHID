export interface DeviceFilter {
  vendorId?: number
  productId?: number
  usagePage?: number
  usage?: number
}
export interface TestGlobals {
  helper: Record<string, unknown> & {
    requestDevice?: (filters: DeviceFilter[]) => void
    requestDeviceResult?: () => Promise<number>
    webhidDeviceAck?: () => Promise<void>
  }
  results: Record<string, unknown>
}

declare global {
  interface Window {
    tests?: TestGlobals
  }

  var tests: TestGlobals | undefined
}
