onmessage = (event) => {
  if (event.data.type !== 'ready') return
  navigator.hid.getDevices().then(
    () => postMessage({ type: 'availability-result', enabled: true }),
    () => postMessage({ type: 'availability-result', enabled: false })
  )
}
