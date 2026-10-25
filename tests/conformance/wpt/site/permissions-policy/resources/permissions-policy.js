function test_feature_availability(featureDescription, test, src, expectResult, featureName) {
  const frame = document.createElement('iframe')
  frame.src = src
  if (typeof featureName !== 'undefined') {
    frame.allow = frame.allow.concat(';' + featureName)
  }

  function onAvailabilityMessage(event) {
    if (event.source !== frame.contentWindow || event.data.type !== 'availability-result') return
    window.removeEventListener('message', onMessage)
    document.body.removeChild(frame)
    expectResult(event.data, featureDescription)
    test.done()
  }

  const onMessage = test.step_func(onAvailabilityMessage)
  window.addEventListener('message', onMessage)
  document.body.appendChild(frame)
}

function expect_feature_available_default(data, featureDescription) {
  assert_true(data.enabled, featureDescription)
}

function expect_feature_unavailable_default(data, featureDescription) {
  assert_false(data.enabled, featureDescription)
}
