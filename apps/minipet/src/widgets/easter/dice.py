# coding:utf-8
# 骰子投掷彩蛋：与硬币彩蛋共享 EasterGamePopup 基类和 Three.js 渲染框架。
# 骰子需要 6 面独立贴图，为避免 QWebEngineView 的跨域限制（file:// 无法加载
# 同目录其他 file:// 资源），贴图在 Python 侧预先读取并转为 base64 data URL 内嵌到 HTML，
# 这样 WebGL 可以正常创建 texture 而不触发 CORS 错误。
import random
import time

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QColor, QFont, QPainter
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QPushButton

import config
from widgets.easter.base import EasterGamePopup


class DicePopup(EasterGamePopup):
    """摇骰子彩蛋弹窗：WebGL 渲染 3D 骰子翻滚动画，落定后展示点数。"""

    title = '摇骰子'

    def __init__(self, x, y, parent=None):
        """先随机出点数，再初始化网页视图与重新投掷按钮。"""
        # 先确定点数再初始化 UI，保证 _html() 拿到最终值来设置 Three.js 骰子的目标旋转角
        self.value = random.randint(1, 6)
        super().__init__(x, y, parent)
        self.setFixedSize(280, 408)
        self.move_to_anchor(x, y)
        self.web = QWebEngineView(self)
        self.web.setGeometry(20, 52, 240, 252)
        self.web.setContextMenuPolicy(Qt.NoContextMenu)
        self.web.setStyleSheet('background: #fff7fa; border: none;')
        self.web.page().setBackgroundColor(QColor(255, 247, 250))
        self.web.setHtml(self._html(self.value), QUrl.fromLocalFile(str(config.RES_DIR / 'items' / 'easter' / '3d' / 'dice.html')))  # base_url 供 three.js 相对加载
        self.web.show()
        self.web.raise_()
        self.button = QPushButton('重新投掷', self)
        self.button.setGeometry(86, 334, 108, 32)
        self.button.setCursor(Qt.PointingHandCursor)
        self.button.setStyleSheet('QPushButton{border:none;border-radius:15px;background:#bd5f86;color:white;font-weight:700;} QPushButton:hover{background:#a84f75;}')
        self.button.clicked.connect(self.roll)
        self.button.show()
        self._play_once('dice_start', 'dice3d')

    def roll(self):
        """重新投掷：刷新点数、重置动画时钟与音效记录，重载网页动画。"""
        self.value = random.randint(1, 6)
        self.started_at = time.monotonic()
        self.played_sounds.discard('dice_land')
        self.played_sounds.discard('dice_start')
        self.web.setHtml(self._html(self.value), QUrl.fromLocalFile(str(config.RES_DIR / 'items' / 'easter' / '3d' / 'dice.html')))
        self._play_once('dice_start', 'dice3d')
        self.update()

    def paintEvent(self, event):
        """绘制卡片背景，动画落定后在底部展示点数结果。"""
        painter = QPainter(self)
        self._draw_card(painter, QColor(255, 247, 250, 248), QColor(238, 180, 202, 230))
        # 骰子动画比硬币稍长（1.8s），等落定后再展示点数结果和落地音效
        if self._elapsed() > 1.8:
            self._play_once('dice_land', 'drop')
            painter.setFont(QFont('Microsoft YaHei UI', 12, QFont.Bold))
            painter.setPen(QColor(116, 56, 82))
            painter.drawText(0, 304, self.width(), 24, Qt.AlignCenter, f'结果：{self.value} 点')

    def _html(self, value):
        """生成内嵌 Three.js 的摇骰子动画页面 HTML（贴图以 base64 内嵌）。"""
        import base64
        three_path = (config.RES_DIR / 'items' / 'easter' / '3d' / 'three.min.js').as_posix()
        dice_dir = config.RES_DIR / 'items' / 'easter' / 'dice'

        # 读取6张PNG贴图并转Base64，内嵌到HTML避免 file:// 跨域问题
        face_data = {}
        for i in range(1, 7):
            png_path = dice_dir / f'face_{i}.png'
            with open(png_path, 'rb') as f:
                b64 = base64.b64encode(f.read()).decode('ascii')
                face_data[i] = f'data:image/png;base64,{b64}'

        # 目标面（顶面）固定为 value，其余5面随机打乱排列在侧面和底面，
        # 保证每次摇出来的骰子朝向都不同，更有随机感
        side_values = [v for v in (1, 2, 3, 4, 5, 6) if v != value]
        random.shuffle(side_values)
        right, left, bottom, front, back = side_values[:5]
        ry = random.randint(0, 359)
        return f"""<!doctype html><html><head><meta charset='utf-8'><style>
html,body{{margin:0;width:100%;height:100%;overflow:hidden;background:#fff7fa;}}
#stage{{width:240px;height:252px;}}
</style></head><body><div id='stage'></div><script src='file:///{three_path}'></script><script>
const W=240,H=252,OA=W/H,OH=5.2;
const scene=new THREE.Scene();
const camera=new THREE.OrthographicCamera(-OH*OA/2,OH*OA/2,OH/2,-OH/2,0.1,100);
camera.position.set(2.6,3.2,5.2); camera.lookAt(0,0.15,0);
const renderer=new THREE.WebGLRenderer({{alpha:true,antialias:true}});
renderer.setSize(W,H); renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
document.getElementById('stage').appendChild(renderer.domElement);
scene.add(new THREE.AmbientLight(0xfff5f8,1.5));
const dL=new THREE.DirectionalLight(0xffffff,1.8); dL.position.set(-1.5,5,4); scene.add(dL);
const fL=new THREE.DirectionalLight(0xffe0f0,0.6); fL.position.set(4,0.5,-1); scene.add(fL);
const shadowMesh=new THREE.Mesh(
  new THREE.CircleGeometry(0.9,48),
  new THREE.MeshBasicMaterial({{color:0x6b3a55,transparent:true,opacity:0.0,depthWrite:false}})
);
shadowMesh.rotation.x=-Math.PI/2; shadowMesh.position.set(0,-1.35,0);
shadowMesh.scale.set(1.2,0.8,1); scene.add(shadowMesh);
const faceDataURLs={{{','.join(f'{i}:"{face_data[i]}"' for i in range(1,7))}}};
const loader=new THREE.TextureLoader();
function faceTex(n){{
  const t=loader.load(faceDataURLs[n],()=>renderer.render(scene,camera));
  t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=renderer.capabilities.getMaxAnisotropy();
  return t;
}}
const mats=[{right},{left},{value},{bottom},{front},{back}].map(n=>
  new THREE.MeshStandardMaterial({{map:faceTex(n),roughness:0.12,metalness:0.0}})
);
const cube=new THREE.Mesh(new THREE.BoxGeometry(1.8,1.8,1.8),mats);
scene.add(cube);
const finalRad={{x:0,y:{ry}*Math.PI/180,z:0}};
const GROUND=-1.15,DICE_R=0.9,THROW_H=3.8;
const DUR_FLY=900,DUR_B1=320,DUR_B2=220,DUR_SETTLE=200;
const TOTAL=DUR_FLY+DUR_B1+DUR_B2+DUR_SETTLE;
const spinX0=(Math.random()*3+2)*Math.PI*2;
const spinY0=(Math.random()*2+1.5)*Math.PI*2;
const spinZ0=(Math.random()*1.5+0.5)*Math.PI*2;
const T0=performance.now();
function tick(now){{
  // 动画四阶段：抛掷翻滚上升 → 第一次弹跳 → 第二次弹跳 → 落定微颤
  const el=now-T0;
  let cy,rx,ry2,rz,sOp,sS;
  if(el<DUR_FLY){{
    const p=el/DUR_FLY,fp=p*p,sd=1-p*0.3;
    cy=GROUND+DICE_R+THROW_H*(1-fp);
    rx=finalRad.x+spinX0*sd*(1-p); ry2=finalRad.y+spinY0*sd*(1-p); rz=spinZ0*(1-p);
    const hr=(1-fp); sOp=0.04+(1-hr)*0.20; sS=0.4+(1-hr)*0.7;
  }} else if(el<DUR_FLY+DUR_B1){{
    const p=(el-DUR_FLY)/DUR_B1,sf=Math.pow(1-p,2);
    cy=GROUND+DICE_R+Math.sin(p*Math.PI)*0.55;
    rx=finalRad.x+spinX0*sf*0.12; ry2=finalRad.y+spinY0*sf*0.10; rz=spinZ0*sf*0.08;
    sOp=0.18-Math.sin(p*Math.PI)*0.06; sS=1.0-Math.sin(p*Math.PI)*0.18;
  }} else if(el<DUR_FLY+DUR_B1+DUR_B2){{
    const p=(el-DUR_FLY-DUR_B1)/DUR_B2;
    cy=GROUND+DICE_R+Math.sin(p*Math.PI)*0.18;
    rx=finalRad.x; ry2=finalRad.y; rz=0;
    sOp=0.20-Math.sin(p*Math.PI)*0.03; sS=1.0-Math.sin(p*Math.PI)*0.06;
  }} else {{
    const p=Math.min(1,(el-DUR_FLY-DUR_B1-DUR_B2)/DUR_SETTLE);
    const j=Math.sin(p*Math.PI*3)*(1-p)*0.018;
    cy=GROUND+DICE_R; rx=finalRad.x+j; ry2=finalRad.y; rz=j*0.5;
    sOp=0.22; sS=1.0;
  }}
  cube.position.y=cy; cube.rotation.x=rx; cube.rotation.y=ry2; cube.rotation.z=rz;
  shadowMesh.material.opacity=Math.min(sOp,0.28);
  const s=Math.max(0.3,sS); shadowMesh.scale.set(s,s,s);
  renderer.render(scene,camera); if(el<TOTAL) requestAnimationFrame(tick);
}}
requestAnimationFrame(tick);
</script></body></html>"""
