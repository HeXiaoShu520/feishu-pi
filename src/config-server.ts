/**
 * 配置界面服务器
 * 提供简单的 Web 界面用于修改 .env 配置
 */
import express from "express";
import bodyParser from "body-parser";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "./utils/logger.js";

const app = express();
const PORT = 3456;
const ENV_FILE = join(process.cwd(), ".env");

// 中间件
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 静态资源：表情图片
app.use("/emojis", express.static(join(process.cwd(), "res", "emojis")));

/**
 * 解析 .env 文件为对象
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * 将配置对象转换为 .env 格式
 */
function stringifyEnv(config: Record<string, string>): string {
  const lines: string[] = [];

  // 飞书配置
  lines.push("FEISHU_APP_ID=" + (config.FEISHU_APP_ID || ""));
  lines.push("FEISHU_APP_SECRET=" + (config.FEISHU_APP_SECRET || ""));
  lines.push("FEISHU_ADMIN=" + (config.FEISHU_ADMIN || ""));
  lines.push("");

  // 随机表情配置
  if (config.FEISHU_RANDOM_EMOJIS) {
    lines.push("# 随机表情配置（逗号分隔的 emoji_type）");
    lines.push("FEISHU_RANDOM_EMOJIS=" + config.FEISHU_RANDOM_EMOJIS);
    lines.push("");
  }

  // 模型配置
  lines.push("# 模型配置");
  const provider = config.FEISHU_PI_MODEL_PROVIDER || "anthropic";
  lines.push("FEISHU_PI_MODEL_PROVIDER=" + provider);
  lines.push("FEISHU_PI_MODEL_ID=" + (config.FEISHU_PI_MODEL_ID || "claude-sonnet-4-6"));
  lines.push("FEISHU_PI_MODEL_BASE_URL=" + (config.FEISHU_PI_MODEL_BASE_URL || ""));
  lines.push("");

  // API Key（根据 provider 写入对应变量）
  lines.push("# API Keys（根据所选 provider 填写对应的 key）");
  const apiKey = config.API_KEY || "";
  if (provider === "anthropic") {
    lines.push("ANTHROPIC_API_KEY=" + apiKey);
    lines.push("OPENAI_API_KEY=");
  } else {
    lines.push("ANTHROPIC_API_KEY=");
    lines.push("OPENAI_API_KEY=" + apiKey);
  }

  return lines.join("\n") + "\n";
}

// 配置页面 HTML
const HTML_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Feishu-Pi 配置</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { margin-bottom: 10px; color: #333; }
    .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
    .section { margin-bottom: 30px; }
    .section-title { font-size: 18px; font-weight: 600; color: #333; margin-bottom: 15px; border-bottom: 2px solid #4CAF50; padding-bottom: 5px; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 5px; color: #555; font-size: 14px; font-weight: 500; }
    input, select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    input:focus, select:focus { outline: none; border-color: #4CAF50; }
    .btn { padding: 12px 24px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; font-weight: 500; }
    .btn-primary { background: #4CAF50; color: white; }
    .btn-primary:hover { background: #45a049; }
    .btn-secondary { background: #666; color: white; margin-left: 10px; }
    .btn-secondary:hover { background: #555; }
    .actions { margin-top: 30px; text-align: right; }
    .message { padding: 12px; border-radius: 4px; margin-bottom: 20px; }
    .message.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
    .message.error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    .hint { font-size: 12px; color: #888; margin-top: 3px; }
    .emoji-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); gap: 8px; margin-top: 10px; }
    .emoji-item { width: 60px; height: 60px; border: 2px solid #ddd; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .emoji-item:hover { border-color: #4CAF50; transform: scale(1.1); }
    .emoji-item.selected { border-color: #4CAF50; background: #e8f5e9; }
    .emoji-item img { width: 48px; height: 48px; }
    .emoji-controls { margin: 10px 0; display: flex; gap: 10px; }
    .emoji-controls button { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; background: white; font-size: 12px; }
    .emoji-controls button:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Feishu-Pi 配置</h1>
    <p class="subtitle">配置飞书应用和 AI 模型参数</p>

    <div id="message"></div>

    <form id="configForm">
      <!-- 飞书配置 -->
      <div class="section">
        <div class="section-title">飞书应用配置</div>
        <div class="form-group">
          <label for="FEISHU_APP_ID">App ID *</label>
          <input type="text" id="FEISHU_APP_ID" name="FEISHU_APP_ID" required>
        </div>
        <div class="form-group">
          <label for="FEISHU_APP_SECRET">App Secret *</label>
          <input type="password" id="FEISHU_APP_SECRET" name="FEISHU_APP_SECRET" required>
        </div>
        <div class="form-group">
          <label for="FEISHU_ADMIN">管理员标识 *</label>
          <input type="text" id="FEISHU_ADMIN" name="FEISHU_ADMIN" required placeholder="支持 Open ID / 姓名 / 邮箱">
          <div class="hint">机器人管理员，支持 Open ID、中文名、英文名或邮箱</div>
        </div>
      </div>

      <!-- 模型配置 -->
      <div class="section">
        <div class="section-title">AI 模型配置</div>
        <div class="form-group">
          <label for="FEISHU_PI_MODEL_PROVIDER">模型提供商</label>
          <select id="FEISHU_PI_MODEL_PROVIDER" name="FEISHU_PI_MODEL_PROVIDER">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="FEISHU_PI_MODEL_ID">模型 ID</label>
          <input type="text" id="FEISHU_PI_MODEL_ID" name="FEISHU_PI_MODEL_ID" placeholder="claude-sonnet-4-6">
        </div>
        <div class="form-group">
          <label for="FEISHU_PI_MODEL_BASE_URL">Base URL *</label>
          <input type="text" id="FEISHU_PI_MODEL_BASE_URL" name="FEISHU_PI_MODEL_BASE_URL" placeholder="https://api.anthropic.com" required>
        </div>
      </div>

      <!-- API Key -->
      <div class="section">
        <div class="section-title">API Key</div>
        <div class="form-group">
          <label for="API_KEY">API Key *</label>
          <input type="password" id="API_KEY" name="API_KEY" required>
          <div class="hint">根据所选模型提供商填写对应的 API Key</div>
        </div>
      </div>

      <!-- 随机表情选择 -->
      <div class="section">
        <div class="section-title">随机表情配置</div>
        <div class="emoji-controls">
          <button type="button" onclick="selectAllEmojis()">全选</button>
          <button type="button" onclick="deselectAllEmojis()">全不选</button>
          <button type="button" onclick="invertEmojiSelection()">反选</button>
        </div>
        <div class="emoji-grid" id="emojiGrid"></div>
        <input type="hidden" id="FEISHU_RANDOM_EMOJIS" name="FEISHU_RANDOM_EMOJIS">
      </div>

      <div class="actions">
        <button type="button" class="btn btn-secondary" onclick="location.reload()">重置</button>
        <button type="submit" class="btn btn-primary">保存配置</button>
      </div>
    </form>
  </div>

  <script>
    const EMOJIS = {
      "OK": "OK", "THUMBSUP": "THUMBSUP", "THANKS": "THANKS", "MUSCLE": "MUSCLE", "FINGERHEART": "FINGERHEART",
      "APPLAUSE": "APPLAUSE", "FISTBUMP": "FISTBUMP", "JIAYI": "JIAYI", "DONE": "DONE", "SMILE": "SMILE",
      "BLUSH": "BLUSH", "LAUGH": "LAUGH", "SMIRK": "SMIRK", "LOL": "LOL", "FACEPALM": "FACEPALM",
      "LOVE": "LOVE", "WINK": "WINK", "PROUD": "PROUD", "WITTY": "WITTY", "SMART": "SMART",
      "SCOWL": "SCOWL", "THINKING": "THINKING", "SOB": "SOB", "CRY": "CRY", "ERROR": "ERROR",
      "NOSEPICK": "NOSEPICK", "HAUGHTY": "HAUGHTY", "SLAP": "SLAP", "SPITBLOOD": "SPITBLOOD", "TOASTED": "TOASTED",
      "GLANCE": "GLANCE", "DULL": "DULL", "INNOCENTSMILE": "INNOCENTSMILE", "JOYFUL": "JOYFUL", "WOW": "WOW",
      "TRICK": "TRICK", "YEAH": "YEAH", "ENOUGH": "ENOUGH", "TEARS": "TEARS", "EMBARRASSED": "EMBARRASSED",
      "KISS": "KISS", "SMOOCH": "SMOOCH", "DROOL": "DROOL", "OBSESSED": "OBSESSED", "MONEY": "MONEY",
      "TEASE": "TEASE", "SHOWOFF": "SHOWOFF", "COMFORT": "COMFORT", "CLAP": "CLAP", "PRAISE": "PRAISE",
      "STRIVE": "STRIVE", "XBLUSH": "XBLUSH", "SILENT": "SILENT", "WAVE": "WAVE", "WHAT": "WHAT",
      "FROWN": "FROWN", "SHY": "SHY", "DIZZY": "DIZZY", "LOOKDOWN": "LOOKDOWN", "CHUCKLE": "CHUCKLE",
      "WAIL": "WAIL", "CRAZY": "CRAZY", "WHIMPER": "WHIMPER", "HUG": "HUG", "BLUBBER": "BLUBBER",
      "WRONGED": "WRONGED", "HUSKY": "HUSKY", "SHHH": "SHHH", "SMUG": "SMUG", "ANGRY": "ANGRY",
      "HAMMER": "HAMMER", "SHOCKED": "SHOCKED", "TERROR": "TERROR", "PETRIFIED": "PETRIFIED", "SKULL": "SKULL",
      "SWEAT": "SWEAT", "SPEECHLESS": "SPEECHLESS", "SLEEP": "SLEEP", "DROWSY": "DROWSY", "YAWN": "YAWN",
      "SICK": "SICK", "PUKE": "PUKE", "BETRAYED": "BETRAYED", "HEADSET": "HEADSET", "EatingFood": "EatingFood",
      "MeMeMe": "MeMeMe", "Sigh": "Sigh", "Typing": "Typing", "Lemon": "Lemon", "Get": "Get",
      "LGTM": "LGTM", "OnIt": "OnIt", "OneSecond": "OneSecond", "VRHeadset": "VRHeadset", "YouAreTheBest": "YouAreTheBest",
      "SALUTE": "SALUTE", "SHAKE": "SHAKE", "HIGHFIVE": "HIGHFIVE", "UPPERLEFT": "UPPERLEFT", "ThumbsDown": "ThumbsDown",
      "SLIGHT": "SLIGHT", "TONGUE": "TONGUE", "EYESCLOSED": "EYESCLOSED", "RoarForYou": "RoarForYou", "CALF": "CALF",
      "BEAR": "BEAR", "BULL": "BULL", "RAINBOWPUKE": "RAINBOWPUKE", "ROSE": "ROSE", "HEART": "HEART",
      "PARTY": "PARTY", "LIPS": "LIPS", "BEER": "BEER", "CAKE": "CAKE", "GIFT": "GIFT",
      "CUCUMBER": "CUCUMBER", "Drumstick": "Drumstick", "Pepper": "Pepper", "CANDIEDHAWS": "CANDIEDHAWS", "BubbleTea": "BubbleTea",
      "Coffee": "Coffee", "Yes": "Yes", "No": "No", "OKR": "OKR", "CheckMark": "CheckMark",
      "CrossMark": "CrossMark", "MinusOne": "MinusOne", "Hundred": "Hundred", "AWESOMEN": "AWESOMEN", "Pin": "Pin",
      "Alarm": "Alarm", "Loudspeaker": "Loudspeaker", "Trophy": "Trophy", "Fire": "Fire", "BOMB": "BOMB",
      "Music": "Music", "XmasTree": "XmasTree", "Snowman": "Snowman", "XmasHat": "XmasHat", "FIREWORKS": "FIREWORKS",
      "2022": "2022", "REDPACKET": "REDPACKET", "FORTUNE": "FORTUNE", "LUCK": "LUCK", "FIRECRACKER": "FIRECRACKER",
      "StickyRiceBalls": "StickyRiceBalls", "HEARTBROKEN": "HEARTBROKEN", "POOP": "POOP", "StatusFlashOfInspiration": "StatusFlashOfInspiration",
      "18X": "18X", "CLEAVER": "CLEAVER", "Soccer": "Soccer", "Basketball": "Basketball", "GeneralDoNotDisturb": "GeneralDoNotDisturb",
      "Status_PrivateMessage": "Status_PrivateMessage", "GeneralInMeetingBusy": "GeneralInMeetingBusy", "StatusReading": "StatusReading",
      "StatusInFlight": "StatusInFlight", "GeneralBusinessTrip": "GeneralBusinessTrip", "GeneralWorkFromHome": "GeneralWorkFromHome",
      "StatusEnjoyLife": "StatusEnjoyLife", "GeneralTravellingCar": "GeneralTravellingCar", "StatusBus": "StatusBus",
      "GeneralSun": "GeneralSun", "GeneralMoonRest": "GeneralMoonRest", "MoonRabbit": "MoonRabbit", "Mooncake": "Mooncake",
      "JubilantRabbit": "JubilantRabbit", "TV": "TV", "Movie": "Movie", "Pumpkin": "Pumpkin",
      "BeamingFace": "BeamingFace", "Delighted": "Delighted", "ColdSweat": "ColdSweat", "FullMoonFace": "FullMoonFace",
      "Partying": "Partying", "GoGoGo": "GoGoGo", "ThanksFace": "ThanksFace", "SaluteFace": "SaluteFace",
      "Shrug": "Shrug", "ClownFace": "ClownFace", "HappyDragon": "HappyDragon"
    };

    // 渲染表情网格
    function renderEmojiGrid() {
      const grid = document.getElementById('emojiGrid');
      grid.innerHTML = '';
      for (const [name, type] of Object.entries(EMOJIS)) {
        const item = document.createElement('div');
        item.className = 'emoji-item';
        item.dataset.type = type;
        item.innerHTML = '<img src="/emojis/' + name + '.png" alt="' + name + '" title="' + name + '">';
        item.onclick = () => toggleEmoji(item);
        grid.appendChild(item);
      }
    }

    // 切换表情选中状态
    function toggleEmoji(item) {
      item.classList.toggle('selected');
      updateEmojiInput();
    }

    // 更新隐藏输入框
    function updateEmojiInput() {
      const selected = Array.from(document.querySelectorAll('.emoji-item.selected'))
        .map(el => el.dataset.type);
      document.getElementById('FEISHU_RANDOM_EMOJIS').value = selected.join(',');
    }

    // 全选
    function selectAllEmojis() {
      document.querySelectorAll('.emoji-item').forEach(el => el.classList.add('selected'));
      updateEmojiInput();
    }

    // 全不选
    function deselectAllEmojis() {
      document.querySelectorAll('.emoji-item').forEach(el => el.classList.remove('selected'));
      updateEmojiInput();
    }

    // 反选
    function invertEmojiSelection() {
      document.querySelectorAll('.emoji-item').forEach(el => el.classList.toggle('selected'));
      updateEmojiInput();
    }

    // 加载配置
    async function loadConfig() {
      const res = await fetch('/api/config');
      const config = await res.json();
      for (const [key, value] of Object.entries(config)) {
        const input = document.getElementById(key);
        if (input && input.type !== 'hidden') input.value = value || '';
      }

      // API_KEY 从对应的 provider key 读取
      const provider = config.FEISHU_PI_MODEL_PROVIDER || 'anthropic';
      const apiKeyInput = document.getElementById('API_KEY');
      if (apiKeyInput) {
        apiKeyInput.value = provider === 'anthropic' ? (config.ANTHROPIC_API_KEY || '') : (config.OPENAI_API_KEY || '');
      }

      // 渲染表情并恢复选择状态
      renderEmojiGrid();
      if (config.FEISHU_RANDOM_EMOJIS) {
        const selected = config.FEISHU_RANDOM_EMOJIS.split(',');
        document.querySelectorAll('.emoji-item').forEach(el => {
          if (selected.includes(el.dataset.type)) {
            el.classList.add('selected');
          }
        });
        updateEmojiInput();
      } else {
        // 默认全选
        selectAllEmojis();
      }
    }

    // 保存配置
    document.getElementById('configForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const config = {};
      for (const [key, value] of formData.entries()) {
        config[key] = value;
      }

      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });

        if (res.ok) {
          showMessage('配置保存成功！重启服务后生效。', 'success');
        } else {
          const error = await res.text();
          showMessage('保存失败：' + error, 'error');
        }
      } catch (err) {
        showMessage('保存失败：' + err.message, 'error');
      }
    });

    // 显示消息
    function showMessage(text, type) {
      const div = document.getElementById('message');
      div.className = 'message ' + type;
      div.textContent = text;
      setTimeout(() => { div.className = ''; div.textContent = ''; }, 5000);
    }

    loadConfig();
  </script>
</body>
</html>
`;

// 路由：配置页面
app.get("/", (req, res) => {
  res.send(HTML_PAGE);
});

// 路由：获取配置
app.get("/api/config", (req, res) => {
  try {
    const content = readFileSync(ENV_FILE, "utf-8");
    const config = parseEnvFile(content);
    res.json(config);
  } catch (err) {
    res.status(500).send("读取配置失败：" + (err as Error).message);
  }
});

// 路由：保存配置
app.post("/api/config", (req, res) => {
  try {
    const config = req.body;
    const envContent = stringifyEnv(config);
    writeFileSync(ENV_FILE, envContent, "utf-8");
    res.send("OK");
  } catch (err) {
    res.status(500).send("保存配置失败：" + (err as Error).message);
  }
});

// 启动服务器
app.listen(PORT, () => {
  logger.log(`配置界面已启动: http://localhost:${PORT}`);
  logger.log(`在浏览器中打开上述地址进行配置`);
});
