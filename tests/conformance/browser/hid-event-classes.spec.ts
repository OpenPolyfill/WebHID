import { test, expect } from '../../helpers/browser.js'
import { navigateToPolicyCheck } from '../../helpers/browser-utils.js'

test.describe('WebHID event WebIDL', () => {
  test.beforeEach(async ({ sharedPage, pageUrl }) => {
    await navigateToPolicyCheck(sharedPage, pageUrl)
  })

  test('connection events preserve device and EventInit members', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(() => {
      const device = Object.create(HIDDevice.prototype) as HIDDevice
      const events = ['connect', 'disconnect'].map((type) => {
        const event = new HIDConnectionEvent(type, {
          device,
          bubbles: true,
          cancelable: true,
          composed: true
        })
        return {
          type: event.type,
          sameDevice: event.device === device,
          isEvent: event instanceof Event,
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          composed: event.composed
        }
      })
      let missingDevice: string | null = null
      try {
        new HIDConnectionEvent('connect')
      } catch (error) {
        missingDevice = error instanceof Error ? error.name : String(error)
      }
      return { events, missingDevice }
    })

    expect(result.events).toEqual([
      {
        type: 'connect',
        sameDevice: true,
        isEvent: true,
        bubbles: true,
        cancelable: true,
        composed: true
      },
      {
        type: 'disconnect',
        sameDevice: true,
        isEvent: true,
        bubbles: true,
        cancelable: true,
        composed: true
      }
    ])
    expect(result.missingDevice).toBe('TypeError')
  })

  test('input report events enforce required members and convert octet values', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate(() => {
      const device = Object.create(HIDDevice.prototype) as HIDDevice
      const data = new DataView(new ArrayBuffer(4))
      const makeEvent = (reportId: unknown) =>
        new HIDInputReportEvent('inputreport', {
          device,
          reportId: reportId as number,
          data
        })
      const values: unknown[] = [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
        256,
        257,
        1.9,
        '1'
      ]
      const convertedIds = values.map((reportId) => makeEvent(reportId).reportId)
      const missingMembers: unknown[] = [
        { reportId: 0, data },
        { device, data },
        { device, reportId: 0 }
      ]
      const missingErrors = missingMembers.map((init) => {
        try {
          new HIDInputReportEvent('inputreport', init as HIDInputReportEventInit)
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
      const event = makeEvent(255)
      return {
        type: event.type,
        isEvent: event instanceof Event,
        isInputReportEvent: event instanceof HIDInputReportEvent,
        sameDevice: event.device === device,
        sameData: event.data === data,
        dataIsDataView: event.data instanceof DataView,
        reportId: event.reportId,
        convertedIds,
        missingErrors
      }
    })

    expect(result).toMatchObject({
      type: 'inputreport',
      isEvent: true,
      isInputReportEvent: true,
      sameDevice: true,
      sameData: true,
      dataIsDataView: true,
      reportId: 255,
      convertedIds: [0, 0, 255, 0, 1, 1, 1],
      missingErrors: ['TypeError', 'TypeError', 'TypeError']
    })
  })
})
