/* ============================================================================
 * desktop/agent/classify.ts —— 软件内置的离线图像识别（1000 类物体）
 *
 * 用 MobileNetV2（ImageNet 1000 类）在本机做推理：
 *   · 模型 14MB 随安装包分发，推理 5-10ms，完全离线、不需要任何 Key
 *   · 输入可以是本地路径 / Buffer / data URL
 *   · 输出 top-5 类别 + 置信度，并尽量翻成中文
 *
 * 这是「这到底是什么」的主力：像素统计只能说颜色和构图，这里才能说出
 * 「篮球」「猫」「笔记本电脑」。风格化插画 / 抽象图置信度会低，如实标注。
 * ==========================================================================*/

import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface ClassifyItem {
  /** ImageNet 英文标签 */
  label: string;
  /** 中文名（没有对应时回落到英文） */
  zh: string;
  /** 0-1 */
  prob: number;
}

export interface ClassifyResult {
  ok: boolean;
  top?: ClassifyItem[];
  ms?: number;
  error?: string;
}

/* ------------------------------------------------------------ 中文标签 */

/**
 * ImageNet 类名 → 中文。按顺序 first-match，所以具体规则要放在宽泛规则前面
 * （例如「table lamp」要排在「table」前面）。没命中的保留英文原名。
 */
const ZH_RULES: Array<[RegExp, string]> = [
  /* 球类与运动 */
  [/basketball/i, '篮球'],
  [/soccer ball/i, '足球'],
  [/volleyball/i, '排球'],
  [/tennis ball/i, '网球'],
  [/baseball/i, '棒球'],
  [/golf ball/i, '高尔夫球'],
  [/ping-pong ball/i, '乒乓球'],
  [/badminton|shuttlecock/i, '羽毛球'],
  [/rugby ball/i, '橄榄球'],
  [/bowling ball/i, '保龄球'],
  [/punching bag|punch bag/i, '沙袋'],
  [/balloon/i, '气球'],
  [/sports equipment|ball/i, '球类'],

  /* 动物 */
  [/giant panda/i, '熊猫'],
  [/tabby|tiger cat|egyptian cat|persian cat|siamese cat/i, '猫'],
  [/dog|retriever|terrier|spaniel|poodle|shepherd|husky|malamute|collie|pug|chihuahua|pomeranian|samoyed|beagle|bloodhound|dingo|basenji/i, '狗'],
  [/hummingbird|kingfisher|woodpecker|vulture|kite|bird|robin|jay|magpie|chickadee|finch|sparrow|eagle|hawk|owl|parrot|macaw|cockatoo|penguin|ostrich|flamingo|heron|stork|pelican|albatross|duck|goose|swan|turkey|peacock/i, '鸟'],
  [/goldfish|shark|ray|salmon|trout|eel|puffer|sturgeon|tench|coho|fish/i, '鱼'],
  [/horse|zebra|pony|sorrel/i, '马'],
  [/cow|ox|bull|bison|buffalo|yak/i, '牛'],
  [/sheep|ram|goat|ibex/i, '羊'],
  [/pig|hog|boar|warthog/i, '猪'],
  [/chicken|hen|rooster|cock/i, '鸡'],
  [/rabbit|hare|bunny/i, '兔子'],
  [/house mouse|field mouse|mouse,|hamster|guinea pig|rat/i, '鼠'],
  [/elephant/i, '大象'],
  [/giant panda|panda/i, '熊猫'],
  [/tiger/i, '老虎'],
  [/lion/i, '狮子'],
  [/leopard|jaguar|cheetah/i, '豹'],
  [/monkey|macaque|baboon|gorilla|chimpanzee|orangutan|gibbon/i, '猴/猿'],
  [/koala/i, '考拉'],
  [/kangaroo|wallaby/i, '袋鼠'],
  [/whale/i, '鲸'],
  [/dolphin/i, '海豚'],
  [/turtle|tortoise/i, '龟'],
  [/snake|python|cobra|viper|boa/i, '蛇'],
  [/lizard|iguana|chameleon|gecko|komodo/i, '蜥蜴'],
  [/frog|toad/i, '蛙'],
  [/spider|tarantula/i, '蜘蛛'],
  [/butterfly|monarch/i, '蝴蝶'],
  [/bee|honeycomb/i, '蜜蜂'],
  [/dragonfly/i, '蜻蜓'],
  [/ladybug/i, '瓢虫'],
  [/bear/i, '熊'],

  /* 交通 */
  [/sports car|convertible|car wheel|minivan|limousine|taxi|jeep|pickup|beach wagon|station wagon|ambulance|police van|fire engine|garbage truck|moving van|tow truck/i, '汽车'],
  [/minibus|trolleybus|bus/i, '公交车'],
  [/truck|trailer|lorry/i, '卡车'],
  [/locomotive|freight car|passenger car|caboose/i, '火车'],
  [/airliner|airplane|warplane/i, '飞机'],
  [/helicopter/i, '直升机'],
  [/speedboat|fireboat|gondola|canoe|catamaran|trimaran|yawl|schooner|container ship|liner|pirate|submarine|lifeboat|sailboat/i, '船'],
  [/mountain bike|tandem|unicycle|bicycle/i, '自行车'],
  [/motorcycle|moped|scooter/i, '摩托车'],
  [/skateboard/i, '滑板'],

  /* 家具与家居 */
  [/table lamp|floor lamp|lampshade|lamp/i, '灯'],
  [/dining table|desk|table/i, '桌子'],
  [/barber chair|folding chair|rocking chair|stool|chair/i, '椅子'],
  [/sofa|couch|studio couch|settee/i, '沙发'],
  [/crib|bassinet|bed/i, '床'],
  [/wardrobe|chiffonier|chest|bookcase|cabinet|file|dresser/i, '柜子'],
  [/mirror/i, '镜子'],
  [/wall clock|digital clock|analog clock|clock/i, '时钟'],
  [/vase/i, '花瓶'],
  [/window shade|shower curtain|curtain/i, '窗帘'],
  [/bathtub|shower|sink|washbasin|toilet/i, '卫浴'],
  [/refrigerator|fridge/i, '冰箱'],
  [/microwave/i, '微波炉'],
  [/oven|stove/i, '炉灶'],
  [/toaster/i, '烤面包机'],
  [/blender/i, '搅拌机'],
  [/dishwasher/i, '洗碗机'],
  [/vacuum/i, '吸尘器'],
  [/iron,|electric iron/i, '熨斗'],
  [/basket|hamper/i, '篮子'],
  [/bucket|pail/i, '桶'],
  [/ladder/i, '梯子'],
  [/broom/i, '扫帚'],
  [/mop/i, '拖把'],
  [/teddy|doll|toyshop|toy/i, '玩偶'],

  /* 电子设备 */
  [/laptop|notebook computer/i, '笔记本电脑'],
  [/desktop computer/i, '台式电脑'],
  [/computer keyboard|keyboard/i, '键盘'],
  [/computer mouse/i, '鼠标'],
  [/monitor|CRT screen|flat panel|screen/i, '显示器'],
  [/cellular telephone|cellphone|smartphone|dial telephone|pay-phone/i, '手机'],
  [/reflex camera|Polaroid|camera/i, '相机'],
  [/television/i, '电视'],
  [/printer/i, '打印机'],
  [/loudspeaker|speaker/i, '音箱'],
  [/headphone|earphone/i, '耳机'],
  [/remote control/i, '遥控器'],

  /* 食物 */
  [/granny smith|apple/i, '苹果'],
  [/banana/i, '香蕉'],
  [/orange|tangerine/i, '橙子'],
  [/strawberry/i, '草莓'],
  [/grape/i, '葡萄'],
  [/watermelon/i, '西瓜'],
  [/pineapple/i, '菠萝'],
  [/lemon/i, '柠檬'],
  [/pomegranate/i, '石榴'],
  [/pizza/i, '披萨'],
  [/cheeseburger|hamburger/i, '汉堡'],
  [/hot dog|hotdog/i, '热狗'],
  [/sandwich/i, '三明治'],
  [/bagel|pretzel|French loaf|bread/i, '面包'],
  [/cupcake|cake/i, '蛋糕'],
  [/chocolate/i, '巧克力'],
  [/ice cream|icecream/i, '冰淇淋'],
  [/espresso|coffee/i, '咖啡'],
  [/teapot|tea/i, '茶'],

  /* 衣物 */
  [/jersey|T-shirt|shirt/i, '上衣'],
  [/jean|trouser/i, '裤子'],
  [/skirt/i, '裙子'],
  [/suit|jacket|blazer|cardigan|sweatshirt/i, '外套'],
  [/sombrero|bonnet|hat|cap/i, '帽子'],
  [/sandal|sneaker|boot|clog|loafer|shoe/i, '鞋'],
  [/necktie|bow tie|tie/i, '领带'],
  [/sock/i, '袜子'],
  [/backpack|purse|wallet|handbag|bag/i, '包'],

  /* 乐器 */
  [/guitar|banjo|ukulele/i, '吉他'],
  [/grand piano|upright|piano/i, '钢琴'],
  [/violin|cello|viola|harp/i, '弦乐器'],
  [/drum|timpani/i, '鼓'],
  [/trumpet|trombone|sax|flute|harmonica/i, '管乐器'],

  /* 自然 */
  [/mushroom|fungus|agaric/i, '蘑菇'],
  [/daisy|sunflower|rose|tulip|orchid|poppy|lotus|daffodil|geranium|petunia|zinnia|marigold/i, '花'],
  [/oak|pine|redwood|willow|palm|maple|birch|poplar|chestnut|sycamore|magnolia|dogwood|juniper|cypress|tree/i, '树'],
  [/volcano|cliff|valley|lakeside|seashore|promontory|mountain/i, '自然风景'],
  [/sunset|sunrise|sky|cloud/i, '天空'],

  /* 文具与杂物 */
  [/comic book|book|notebook/i, '书'],
  [/ballpoint|fountain pen|pencil|pen/i, '笔'],
  [/scissors/i, '剪刀'],
  [/umbrella/i, '雨伞'],
  [/stopwatch|watch/i, '手表'],
];

function toZh(label: string): string {
  for (const [re, zh] of ZH_RULES) {
    if (re.test(label)) return zh;
  }
  return label;
}

/* ------------------------------------------------------------ 模型 */

let sessionPromise: Promise<any> | null = null;
let labelsCache: string[] | null = null;

/**
 * 模型目录。
 * 打包后必须放在 asar **外面**：onnxruntime 的 C++ 层直接按路径打开文件，
 * 不经过 Electron 的 fs 补丁，读不到 app.asar 里的条目。
 */
function modelDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'models');
  return path.join(app.getAppPath(), 'assets', 'models');
}

function modelPath(): string {
  return path.join(modelDir(), 'mobilenet.onnx');
}

function synsetPath(): string {
  return path.join(modelDir(), 'synset.txt');
}

function loadLabels(): string[] {
  if (labelsCache) return labelsCache;
  const raw = fs.readFileSync(synsetPath(), 'utf8').trim().split(/\r?\n/);
  labelsCache = raw.map(line => {
    const i = line.indexOf(' ');
    return (i > 0 ? line.slice(i + 1) : line).trim();
  });
  return labelsCache;
}

/**
 * 加载原生推理库。
 * 用 require（CJS）而不是 import()：主进程被打成 CommonJS，打包后 import('onnxruntime-node')
 * 会按 ESM 解析 rules 走一遍 package exports，在 asar 里容易解析失败；require 直接命中 main。
 */
function loadOrt(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('onnxruntime-node');
}

async function getSession(): Promise<any> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const p = modelPath();
      if (!fs.existsSync(p)) throw new Error('内置识别模型缺失（resources/models/mobilenet.onnx）');
      const ort = loadOrt();
      return ort.InferenceSession.create(p);
    })();
  }
  return sessionPromise;
}

function toTensor(img: Electron.NativeImage, ort: any): any {
  const { width, height } = img.getSize();
  const side = Math.max(1, Math.min(width, height));
  const cropped = img.crop({
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    width: side,
    height: side,
  });
  const resized = cropped.resize({ width: SIZE, height: SIZE, quality: 'good' });
  const bmp = resized.toBitmap(); // BGRA
  const plane = SIZE * SIZE;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const b = bmp[i * 4] / 255;
    const g = bmp[i * 4 + 1] / 255;
    const r = bmp[i * 4 + 2] / 255;
    data[i] = (r - MEAN[0]) / STD[0];
    data[plane + i] = (g - MEAN[1]) / STD[1];
    data[2 * plane + i] = (b - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]);
}

function topK(logits: Float32Array | number[], k: number): ClassifyItem[] {
  const arr = Array.from(logits as ArrayLike<number>);
  const idx = arr
    .map((v, i) => ({ i, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, k);
  const max = idx[0]?.v ?? 0;
  const exps = idx.map(t => Math.exp(t.v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const labels = loadLabels();
  return idx.map((t, n) => {
    const label = labels[t.i] ?? `class-${t.i}`;
    return { label, zh: toZh(label), prob: exps[n] / sum };
  });
}

/** 对一张图做 1000 类识别；任何失败都返回 ok:false，不抛异常 */
export async function classifyImage(input: { path?: string; bytes?: Buffer }): Promise<ClassifyResult> {
  const started = Date.now();
  try {
    const img = input.path
      ? nativeImage.createFromPath(input.path)
      : input.bytes
        ? nativeImage.createFromBuffer(input.bytes)
        : nativeImage.createEmpty();
    if (!img || img.isEmpty()) return { ok: false, error: '图片解码失败' };
    const session = await getSession();
    const ortModule = loadOrt();
    const tensor = toTensor(img, ortModule);
    const feeds: Record<string, unknown> = {};
    feeds[session.inputNames[0]] = tensor;
    const out = await session.run(feeds);
    const logits = out[session.outputNames[0]].data as Float32Array;
    const top = topK(logits, 5);
    return { ok: true, top, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: (err as Error).message, ms: Date.now() - started };
  }
}

/** 识图报告里的「这是什么」段落 */
export function classifyToText(top: ClassifyItem[], query?: string): string {
  const best = top[0];
  if (!best) return '';
  const pct = (p: number) => `${(p * 100).toFixed(p >= 0.1 ? 0 : 1)}%`;
  const lines = ['【这是什么】软件内置的离线识别模型（MobileNetV2，1000 类，本机推理）判断：'];
  lines.push(`- 最可能：${best.zh}（${pct(best.prob)}）${best.zh !== best.label ? ` · ${best.label}` : ''}`);
  const others = top.slice(1, 4).filter(t => t.prob >= 0.03);
  if (others.length) {
    lines.push(`- 其他可能：${others.map(t => `${t.zh} ${pct(t.prob)}`).join('、')}`);
  }
  if (best.prob < 0.25) {
    lines.push('- 置信度偏低：这张图可能是插画、抽象图形或非实拍画面，模型只能给出大致方向。');
  } else if (best.prob >= 0.6) {
    lines.push('- 置信度较高，可以直接按这个结论回答用户。');
  }
  if (query && query.trim()) {
    lines.push(`（用户这条问题问的是「${query.trim().slice(0, 60)}」，结合上面的识别结果回答即可。）`);
  }
  return lines.join('\n');
}
