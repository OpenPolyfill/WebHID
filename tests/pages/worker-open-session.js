self.onmessage = async () => {
  try {
    const devices = await navigator.hid.getDevices()
    const device = devices.find((x) => x.vendorId === 0x16c0 && x.productId === 0x0001)
    if (!device) throw new Error('paired test device missing')
    device.oninputreport = () => self.postMessage({ type: 'report' })
    await device.open()
    self.postMessage({ type: 'ready' })
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
