const { getBookingGuide } = require('../core/service')
const { exec } = require('child_process')
const hospitals = require('../data/hospitals.json')
const { matchHospital } = require('../core/resolver')
const { extractHospitalKeyword } = require('../core/preprocessor')

module.exports = async function (input) {
  const guide = await getBookingGuide(input.query, input.lang || 'zh')
  
  // 异步打开浏览器（不阻塞返回）
  setImmediate(() => {
    try {
      const keyword = extractHospitalKeyword(input.query)
      const hospital = matchHospital(keyword, hospitals)
      if (hospital && hospital.url) {
        const command = process.platform === 'darwin' ? `open "${hospital.url}"` : `start "${hospital.url}"`
        exec(command, (err) => {
          if (err) console.error('[Booking Skill] Failed to open browser:', err.message)
          else console.log(`[Booking Skill] Opened: ${hospital.url}`)
        })
      }
    } catch (err) {
      console.error('[Booking Skill] Error opening browser:', err.message)
    }
  })
  
  return guide
}
