;(async function () {
  const VENDOR_VID = 0x16c0
  const VENDOR_PID = 0x0001

  self.onmessage = async (event) => {
    if (!event.data || event.data.type !== 'start') return
    const id = event.data.id
    try {
      const devices = await navigator.hid.getDevices()
      const device = devices.find((x) => x.vendorId === VENDOR_VID && x.productId === VENDOR_PID)
      if (!device) throw new Error('no paired device for ' + id)
      let closing = false
      device.oninputreport = (reportEvent) => {
        if (closing) return
        closing = true
        const view = new Uint8Array(
          reportEvent.data.buffer,
          reportEvent.data.byteOffset,
          reportEvent.data.byteLength
        )
        self.postMessage({
          type: 'report',
          id,
          value: { reportId: reportEvent.reportId, bytes: Array.from(view) }
        })
        void device
          .close()
          .then(() => self.postMessage({ type: 'closed', id }))
          .catch((error) =>
            self.postMessage({
              type: 'error',
              id,
              message: error instanceof Error ? error.message : String(error)
            })
          )
      }
      await device.open()
      self.postMessage({ type: 'ready', id })
    } catch (error) {
      self.postMessage({
        type: 'error',
        id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
})()
