const { getBookingGuide } = require('../core/service')
const { exec } = require('child_process')
const { promisify } = require('util')
const playwright = require('playwright')
const hospitals = require('../data/hospitals.json')
const { matchHospital } = require('../core/resolver')
const { extractHospitalKeyword } = require('../core/preprocessor')

const execAsync = promisify(exec)

/**
 * 识别用户意图
 * 严格的意图识别：必须包含明确的操作词
 * @param {string} query 用户输入
 * @returns {string} 意图类型：'view' | 'open' | 'book' | 'consult'
 */
function detectIntent(query) {
  const q = query.toLowerCase()
  
  // 用户想咨询客服（优先级最高）
  if (q.includes('咨询') || q.includes('客服')) {
    return 'consult'
  }
  
  // 用户想点击预约按钮（自动化预约）
  if (q.includes('帮我预约') || q.includes('直接预约') || q.includes('点击预约')) {
    return 'book'
  }
  
  // 用户明确要打开链接
  if (q.includes('打开链接') || q.includes('打开页面')) {
    return 'open'
  }
  
  // 默认：查看预约流程（包括所有含有医院名称的查询，如果没有明确操作词）
  return 'view'
}

/**
 * 打开浏览器
 */
async function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      await execAsync(`open "${url}"`)
    } else if (process.platform === 'win32') {
      await execAsync(`start "${url}"`)
    } else {
      await execAsync(`xdg-open "${url}"`)
    }
    console.log(`[Booking Skill] Browser opened: ${url}`)
    return true
  } catch (err) {
    console.error('[Booking Skill] Failed to open browser:', err.message)
    return false
  }
}

/**
 * 自动点击预约按钮
 */
async function clickBookingButton(url) {
  let browser
  try {
    browser = await playwright.chromium.launch({ headless: false })
    const context = await browser.newContext()
    const page = await context.newPage()
    
    await page.goto(url, { waitUntil: 'networkidle' })
    console.log(`[Booking Skill] Page loaded: ${url}`)
    
    // 查找并点击预约按钮
    const bookingButton = await page.locator('.btns-right:has-text("预约面诊")').first()
    
    if (bookingButton) {
      await bookingButton.click()
      console.log(`[Booking Skill] Booking button clicked`)
      // 等待页面跳转
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 5000 }).catch(() => {})
      return true
    } else {
      console.warn('[Booking Skill] Booking button not found')
      return false
    }
  } catch (err) {
    console.error('[Booking Skill] Failed to click booking button:', err.message)
    return false
  } finally {
    if (browser) await browser.close()
  }
}

/**
 * 自动点击客服咨询按钮
 * 优化：使用 waitForSelector + 直接 DOM 操作的混合策略
 */
async function clickConsultButton(url) {
  let browser
  try {
    browser = await playwright.chromium.launch({ headless: false })
    const context = await browser.newContext()
    const page = await context.newPage()
    
    // 使用 networkidle，确保所有资源加载完成
    console.log(`[Booking Skill] Loading page: ${url}`)
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
    
    console.log(`[Booking Skill] Waiting for Vue components to render...`)
    await page.waitForTimeout(8000)  // 增加到 8 秒，确保 Vue 完全初始化
    
    console.log(`[Booking Skill] Looking for consult button...`)
    
    // 策略 1: 用 waitForSelector 等待 .btns-consult 元素出现
    try {
      console.log(`[Booking Skill] Attempting to wait for .btns-consult selector...`)
      await page.waitForSelector('.btns-consult', { timeout: 10000 }).catch(() => {})
      console.log(`[Booking Skill] .btns-consult selector detected`)
    } catch (e) {
      console.log(`[Booking Skill] .btns-consult not found with waitForSelector`)
    }
    
    // 策略 2: 直接在浏览器中点击
    const clickSuccess = await page.evaluate(() => {
      try {
        // 方法 1: 用 class 选择器
        let button = document.querySelector('.btns-consult')
        if (button) {
          console.log(`[DOM] Found .btns-consult button`)
          button.click()
          return true
        }

        // 方法 2: 用精确文本搜索
        const elements = document.querySelectorAll('*')
        for (const el of elements) {
          const text = (el.textContent || '').trim()
          
          // 精确匹配"咨询一下"
          if (text === '咨询一下' && el.offsetParent !== null) {
            console.log(`[DOM] Found exact match "咨询一下"`)
            el.click()
            return true
          }
          
          // 精确匹配仅包含"咨询一下"（不是子元素的组合）
          if (text === '咨询一下') {
            const children = el.children
            let isSmallElement = true
            for (const child of children) {
              if (child.textContent.length > 30) {
                isSmallElement = false
                break
              }
            }
            if (isSmallElement && el.offsetParent !== null) {
              console.log(`[DOM] Found btns-right element with "咨询一下"`)
              el.click()
              return true
            }
          }
        }

        // 方法 3: 查找最小的包含"咨询一下"的可见元素
        let targetButton = null
        let minTextLength = Infinity
        
        for (const el of elements) {
          const text = (el.textContent || '').trim()
          
          // 必须包含"咨询"，且元素可见
          if (text.includes('咨询') && el.offsetParent !== null) {
            // 优先选择文本短的元素（更接近按钮本身）
            if (text.length < minTextLength && text.length < 100) {
              minTextLength = text.length
              targetButton = el
            }
          }
        }

        if (targetButton) {
          console.log(`[DOM] Found target button with text: "${targetButton.textContent.trim().substring(0, 30)}"`)
          targetButton.click()
          return true
        }

        return false
      } catch (e) {
        console.log(`[DOM] Error during evaluation: ${e.message}`)
        return false
      }
    })

    if (clickSuccess) {
      console.log(`[Booking Skill] ✅ Consult button clicked successfully`)
      await page.waitForTimeout(3000)  // 等待页面响应
      return true
    }
    
    // 最后的降级方案：用 Playwright 点击
    try {
      console.log(`[Booking Skill] Trying Playwright selectors as fallback...`)
      
      const fallbackSelectors = [
        'text=/咨询一下/',
        '[class*="consult"]',
        'text=/咨询/',
      ]
      
      for (const selector of fallbackSelectors) {
        try {
          const locator = page.locator(selector).first()
          const count = await locator.count()
          
          if (count > 0) {
            const isVisible = await locator.isVisible().catch(() => false)
            if (isVisible) {
              console.log(`[Booking Skill] Found with selector: ${selector}`)
              await locator.click()
              console.log(`[Booking Skill] ✅ Clicked with fallback selector`)
              await page.waitForTimeout(2000)
              return true
            }
          }
        } catch (e) {
          // 继续尝试下一个
        }
      }
    } catch (e) {
      console.error(`[Booking Skill] Fallback selectors failed: ${e.message}`)
    }
    
    console.warn('[Booking Skill] ❌ Consult button could not be found or clicked')
    return false
  } catch (err) {
    console.error('[Booking Skill] Failed to click consult button:', err.message)
    return false
  } finally {
    if (browser) await browser.close()
  }
}

/**
 * 获取医院信息的友好描述
 */
function getHospitalDescription(hospital) {
  return `📍 ${hospital.name} (${hospital.en_name})`
}

/**
 * 主 Skill 入口
 */
module.exports = async function (input) {
  const { query, context = {} } = input
  const lang = input.lang || 'zh'
  const intent = detectIntent(query)
  
  try {
    // 第1轮：用户问"怎么预约XXX"
    if (intent === 'view') {
      const guide = await getBookingGuide(query, lang)
      
      // 返回预约流程说明 + 三个清晰的操作选项
      return `${guide}

---
💡 **接下来，选择你想要的操作：**

📖 **查看医院信息**
说"打开链接" → 我帮你打开医院页面（从 JSON 中读取 URL）

⚡ **自动预约**
说"帮我预约" → 我帮你点击【预约按钮】，跳转到预约表单

💬 **在线咨询**
说"咨询客服" → 我帮你点击【咨询按钮】，联系医院客服

---
你想做哪个？😊`
    }
    
    // 第2轮：用户说"打开链接"
    if (intent === 'open') {
      // 从 context 中获取医院信息，或重新解析 query
      let hospital = context.hospital
      if (!hospital) {
        // 如果 context 中没有医院，尝试从原始查询中解析
        const keyword = extractHospitalKeyword(query)
        hospital = matchHospital(keyword, hospitals)
      }
      
      if (!hospital) {
        return '❌ 抱歉，我无法识别医院名称。请告诉我你要预约哪家医院的名称。'
      }
      
      const opened = await openBrowser(hospital.url)
      if (!opened) {
        return `❌ 链接打开失败，请手动访问：${hospital.url}`
      }
      
      return `✅ 链接已打开！正在加载 ${hospital.name} 的预约页面...

页面地址：${hospital.url}

你可以在浏览器中看到：
• 📍 医院地址和地图
• ⏰ 营业时间
• 💰 价格表和优惠
• 📷 医院环境照片
• 👨‍⚕️ 医生团队介绍
• ✅ 预约按钮

接下来，你可以：
• "帮我预约" - 我帮你自动点击预约按钮
• "需要截图" - 我可以帮你看看页面内容
• 或继续咨询其他问题 😊`
    }
    
    // 第3轮：用户说"帮我预约"或"点击预约按钮"
    if (intent === 'book') {
      // 从 context 或查询中获取医院信息
      let hospital = context.hospital
      if (!hospital) {
        const keyword = extractHospitalKeyword(query)
        hospital = matchHospital(keyword, hospitals)
      }
      
      if (!hospital) {
        return '❌ 抱歉，我无法识别医院名称。请告诉我你要预约哪家医院的名称。'
      }
      
      // 先打开浏览器
      await openBrowser(hospital.url)
      
      // 然后自动点击预约按钮
      const clicked = await clickBookingButton(hospital.url)
      
      if (clicked) {
        return `✅ 已帮你点击预约按钮！页面已跳转到预约表单。

${hospital.name} 的预约页面已在浏览器中打开，请按照以下步骤继续：

📝 请填写以下信息：
• 您的姓名
• 联系电话
• 预约日期和时间
• 选择医生（如适用）
• 服务项目描述

💳 完成后点击"确认预约"或"提交"

如果需要帮助，随时告诉我！😊`
      } else {
        return `⚠️ 自动点击预约按钮失败，但页面已打开。

请手动点击以下位置的预约按钮：
• 在 ${hospital.name} 页面上找到蓝色的"预约面诊"按钮
• 点击进入预约表单
• 填写你的信息完成预约

或告诉我"打开链接"，我会重新为你打开。`
      }
    }
    
    // 第4轮：用户说"咨询客服"
    if (intent === 'consult') {
      let hospital = context.hospital
      if (!hospital) {
        const keyword = extractHospitalKeyword(query)
        hospital = matchHospital(keyword, hospitals)
      }
      
      if (!hospital) {
        return '❌ 抱歉，我无法识别医院名称。请告诉我你要咨询哪家医院。'
      }
      
      // 打开浏览器
      await openBrowser(hospital.url)
      
      // 自动点击咨询按钮
      const clicked = await clickConsultButton(hospital.url)
      
      if (clicked) {
        return `✅ 已帮你打开 ${hospital.name} 的咨询对话页面！

我已经：
• 打开了医院页面
• 自动点击了"咨询一下"按钮

现在页面应该已经跳转到在线客服对话窗口。你可以：
• 📝 在对话框中输入你的问题
• ❓ 询问价格、预约时间、医生等信息
• 💬 直接与客服沟通

如果对话窗口没有自动打开，请手动查看页面右下角或页面上是否有客服对话框。

还需要其他帮助吗？😊`
      } else {
        return `⚠️ 自动点击咨询按钮失败，但页面已打开。

我已经为你打开了 ${hospital.name} 的页面。

请手动点击以下位置的咨询按钮：
• 页面上方或右侧的蓝色"咨询一下"按钮
• 或右下角的"在线客服"按钮
• 点击后会打开客服对话窗口

医院页面地址：${hospital.url}

还需要其他帮助吗？😊`
      }
    }
    
  } catch (err) {
    console.error('[Booking Skill] Error:', err.message)
    return `❌ 处理请求时出错：${err.message}。请重试或联系客服。`
  }
}
