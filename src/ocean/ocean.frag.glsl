varying vec2 vUv;
uniform vec3 uFocus;
float lensContact=0.;

// 全景照片中烘焙的太阳位置；照片仅提供云层与天空亮度，太阳本体由物理光源生成。
const vec2 SKY_SUN_UV = vec2(.6879, .4045);

float henyeyGreenstein(float mu, float g) {
  float g2 = g * g;
  return (1. - g2) / (4. * PI * pow(max(1. + g2 - 2. * g * mu, 1e-5), 1.5));
}

// 照片中烘焙的太阳约在地平线上 0.7°；分段映射把它对齐到物理太阳仰角，
// 使照片里的暖色光晕、云隙亮边与唯一的世界太阳同位。
float skyV(float elev) {
  float e = max(elev, 0.);
  float sunElevation = asin(uSunDirection.y);
  const float SUN_V = .4045 - .381;
  float lower = SUN_V * e / sunElevation;
  float upper = SUN_V + (.619 - SUN_V) * pow(clamp((e - sunElevation) / (.65 - sunElevation), 0., 1.), .82);
  return .381 + (e < sunElevation ? lower : upper);
}

// 云贴图是摄影风格 LDR 素材，方位平移让照片中的暖色云隙与物理太阳重合。
vec3 skyRadiance(vec3 d, bool disc, float environmentLod) {
  float azimuth = atan(d.x, -d.z);
  float elev = asin(clamp(d.y,-1.,1.));
  float sunAzimuth = atan(uSunDirection.x, -uSunDirection.z);
  float ty = skyV(elev);
  float tx = SKY_SUN_UV.x + (azimuth - sunAzimuth) / 2.48;
  // 后半球沿边缘继续云场，避免跨缝；前方构图保留原始云层。
  tx = 1. - abs(mod(tx,2.)-1.);
  vec2 skyUV=vec2(clamp(tx,.002,.998),clamp(ty,.384,.996));
  vec3 photo=textureLod(uSky,skyUV,environmentLod).rgb;
  // 分离摄影天空中烘焙的小太阳，光源仅由统一的角度辐亮度生成。
  float diskMask=1.-smoothstep(.005,.017,length((skyUV-SKY_SUN_UV)*vec2(1.,.5)));
  vec3 noDisk=.5*(textureLod(uSky,skyUV+vec2(.019,0.),environmentLod).rgb+textureLod(uSky,skyUV-vec2(.019,0.),environmentLod).rgb);
  vec3 cloud=pow(mix(photo,noDisk,diskMask),vec3(2.2));
  vec3 zenith = vec3(.16,.34,.57);
  cloud = mix(cloud,zenith,smoothstep(.6,1.35,elev));
  float mu = dot(d,uSunDirection);
  float mu0 = dot(d,uSunDirection);
  // 照片天空的白平衡偏冷；日落时近地平线与太阳方向的天光同样经过长气柱，短波被削弱。
  float warmth = exp(-max(elev,0.) * 9.) * (.55 + .45 * smoothstep(.6, 1., mu0));
  vec3 col = cloud * .86 * mix(vec3(1.), vec3(.74,.6,.6), warmth);
  // 低太阳穿过长气柱：Mie 前向散射形成暖色光晕（窄峰 + 宽晕），地平线以下被海面遮住。
  // 光晕沿整段光路产生，平均光程短于直射光，因此比日面直射光偏白。
  float aboveHorizon = smoothstep(-.02,.015,d.y);
  vec3 aureoleColor = SUN_IRRADIANCE * vec3(.45,.36,.3);
  col += aureoleColor * (.016 * henyeyGreenstein(mu,.96) + .045 * henyeyGreenstein(mu,.78)) * aboveHorizon;
  // 地平线低空的暖色消光带，与太阳方位相关。
  float horizonBand = exp(-max(d.y,0.) * 22.) * aboveHorizon;
  col += vec3(.20,.085,.02) * horizonBand * (.35 + .65 * pow(max(mu,0.), 6.));
  if(disc) {
    // 真实角半径的日面，含临边昏暗；环形软边仅用于抗锯齿，能量按立体角归一。
    float r = length(cross(d, uSunDirection));
    float sun = 1. - smoothstep(SUN_INNER_RADIUS, SUN_OUTER_RADIUS, r);
    float limb = 1. - .5 * (1. - sqrt(max(1. - (r / SUN_OUTER_RADIUS) * (r / SUN_OUTER_RADIUS), 0.)));
    col += SUN_RADIANCE * sun * limb * 1.18 * step(0., mu);
  }
  return col;
}

vec3 skyRadiance(vec3 d, bool disc) {
  return skyRadiance(d,disc,disc?0.:4.);
}

float dielectric(float c, float etaI, float etaT) {
  c = clamp(c,0.,1.);
  float st = (etaI/etaT)*(etaI/etaT)*(1.-c*c);
  if(st >= 1.) return 1.;
  float ct = sqrt(1.-st);
  float rs=(etaI*c-etaT*ct)/(etaI*c+etaT*ct);
  float rp=(etaT*c-etaI*ct)/(etaT*c+etaI*ct);
  return .5*(rs*rs+rp*rp);
}

vec3 exitEnvironment(vec3 d, bool disc, float lod) {
  vec3 sky=skyRadiance(d,disc,lod);
  if(d.y>=.02)return sky;
  // 从斜浪面离开后仍朝下的空气光路会再次遇水，不能直接读取金色天空。
  // 用空气侧平面水面作远场近似，避免为每个像素再追踪一次完整海面。
  vec3 reflected=normalize(vec3(d.x,abs(d.y),d.z));
  float F=dielectric(abs(d.y),1.,IOR);
  vec3 sea=mix(vec3(.0015,.009,.013),skyRadiance(reflected,false,max(lod,3.)),F);
  return mix(sea,sky,smoothstep(-.02,.02,d.y));
}

// 双面波场相交，按高度差保守前进并二分最近的符号变化；高度按像素足迹过滤。
float intersectSea(vec3 ro,vec3 rd,float side) {
  float t = 0.008;
  const float envelope = 1.9;
  if(side*ro.y > envelope) {
    if(side*rd.y >= 0.) return -1.;
    t=max(t,(side*ro.y-envelope)/(-side*rd.y));
  }
  float prevT=t;
  float previous=side*(ro.y+rd.y*t-seaHeight(ro.xz+rd.xz*t,t*uPixelAngle));
  for(int i=0;i<88;i++) {
    vec3 p=ro+rd*t;
    float footprint=t*uPixelAngle;
    float h=side*(p.y-seaHeight(p.xz,footprint));
    if(h<=0. && previous>0.) {
      float a=prevT,b=t;
      for(int j=0;j<10;j++) {
        float m=.5*(a+b);
        vec3 mp=ro+rd*m;
        if(side*(mp.y-seaHeight(mp.xz,footprint)) > 0.) a=m; else b=m;
      }
      return .5*(a+b);
    }
    if(h>0. && h<.003+t*.00002) {
      // 正残差不构成二分区间；沿真实波面切平面连续求根，避免步长等高线。
      float root=t;
      for(int j=0;j<3;j++) {
        vec3 q=ro+rd*root;
        float residual=q.y-seaHeight(q.xz,footprint);
        vec3 n=waveNormal(q.xz,root);
        float derivative=dot(n,rd)/max(n.y,.1);
        if(abs(derivative)>.02)root-=clamp(residual/derivative,-.08,.08);
      }
      return max(.001,root);
    }
    prevT=t;
    previous=h;
    t += max(.006,abs(h)*.78/(abs(rd.y)+.6));
    if(t>360. || side*p.y>envelope+1.5) break;
  }
  // 有界二分兜底：波包包络保证两端异号，避免掠射视角出现天空空洞。
  if(side*rd.y < -.001) {
    float a=0.,b=max(.01,(side*ro.y+1.9)/(-side*rd.y));
    for(int j=0;j<18;j++) {
      float m=(a+b)*.5;
      vec3 p=ro+rd*m;
      if(side*(p.y-seaHeight(p.xz,m*uPixelAngle))>0.)a=m;else b=m;
    }
    return (a+b)*.5;
  }
  return -1.;
}

// 整片海面的均方斜率：各层最粗 mip 的 E[|∇h|²]（平均斜率为零）。远场统计分布以平均海平面为中心。
float totalSlopeVariance() {
  return textureLod(uSurface, vec2(.5), 12.).a + textureLod(uDetailSurface, vec2(.5), 12.).a + textureLod(uRippleSurface, vec2(.5), 12.).a;
}

float ggxD(float nh, float a2) {
  float d = nh * nh * (a2 - 1.) + 1.;
  return a2 / (PI * d * d);
}
float beckmannD(float nh, float a2) {
  float c2 = max(nh * nh, 1e-4);
  return exp((c2 - 1.) / (c2 * a2)) / (PI * a2 * c2 * c2);
}
float smithG1(float nx, float a2) {
  nx = max(nx, 1e-4);
  return 2. * nx / (nx + sqrt(a2 + (1. - a2) * nx * nx));
}
float smithLambda(float nx, float a2) {
  nx = max(nx, 1e-4);
  return .5 * (sqrt(1. + a2 * (1. - nx * nx) / (nx * nx)) - 1.);
}
// 高度相关的 Smith 遮蔽-阴影（Heitz 2014）：同一道浪脊既挡视线又挡阳光时不重复计算。
// 掠射的太阳与视线分处两侧，独立相乘的 G1·G1 会把光柱压暗约三倍。
float smithG2(float nv, float nl, float a2) {
  return 1. / (1. + smithLambda(nv, a2) + smithLambda(nl, a2));
}

// 世界空间随机闪点：每个单元代表一片毛细波微面，在自己的相位上淡入淡出。
// 单元点亮概率取自 GGX 分布（对准太阳的微面比例），亮度除以概率，期望值恰为平滑高光。
// 光斑用像素足迹（横向 w.x、沿视线 w.y）预过滤，掠射处自然压成横向短划，不形成网点。
// 反光微面沿浪脊线排布：浪脊垂直于风向（此机位下横贯画面），单个闪点沿脊线拉长约 4 倍。
float glintLevel(vec2 p, float cell, vec2 across, vec2 along, vec2 w, float lambda, float seed) {
  vec2 g = p / cell;
  vec2 base = floor(g);
  float sigma = .2 * cell;
  vec2 variance = sigma * sigma * vec2(3.6, .22) + w * w * .25;
  // λ 为单元内对准太阳的微面期望个数：λ<1 时单元以概率 λ 点亮；λ≥1 时每个单元都亮，
  // 闪烁起伏按 1/√λ 收敛，远处大单元因此汇成连续光带而不是稀疏亮点。
  float lit = min(lambda, 1.);
  float spread = min(1., 1.2 * inversesqrt(max(lambda, 1e-4)));
  float sum = 0.;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++) {
    vec2 id = base + vec2(float(i), float(j));
    vec2 wrapped = mod(id, 4096.);
    float phase = uTime * 3.2 + hash12(wrapped + seed * 1.37) * 9.;
    float slot = floor(phase);
    if(hash12(wrapped * 1.13 + vec2(slot * 7.31, seed)) > lit) continue;
    float fade = sin(PI * fract(phase));
    float amplitude = 1. + (2. * fade * fade - 1.) * spread;
    vec2 q = (g - id - (.15 + .7 * hash22(wrapped + slot * .731 + seed))) * cell;
    float qa = dot(q, across), qb = dot(q, along);
    sum += amplitude * exp(-.5 * (qa * qa / variance.x + qb * qb / variance.y));
  }
  return sum * cell * cell / (2. * PI * sqrt(variance.x * variance.y) * max(lit, 1e-4));
}
float glintFactor(vec2 p, vec3 rd, float t, vec3 n, float probability) {
  float wa = max(t * uPixelAngle, 1e-5);
  float wb = wa * footprintStretch(n, rd);
  vec2 along = normalize(rd.xz + vec2(1e-5, 0.));
  vec2 across = vec2(-along.y, along.x);
  const float BASE = .011;
  float level = log2(max(max(BASE, wa * 1.2), wb / 3.) / BASE);
  float l0 = floor(level);
  float c0 = BASE * exp2(l0);
  float lambda = probability * exp2(2. * l0);
  float x0 = glintLevel(p, c0, across, along, vec2(wa, wb), lambda, l0 * 57.);
  float x1 = glintLevel(p, c0 * 2., across, along, vec2(wa, wb), lambda * 4., (l0 + 1.) * 57.);
  return mix(x0, x1, fract(level));
}
// 单片毛细微面（约 1cm）对准太阳的概率：GGX 密度乘以微面自身曲率张开的立体角。
float glintProbability(float D) {
  return clamp(D * PI * .03, 1e-4, 1.);
}

const float CAPILLARY_TAIL = .2;
// 海面阳光反射：GGX + Smith，nl 已与渲染方程中的余弦抵消。
// 分布 D 以像素内的平均法线为中心（保留浪脊结构）；已解析浪的遮挡由显式阴影光线处理，
// 未解析微面的自遮挡相对平均海平面统计——掠射时平均法线常背向低太阳，
// 但足迹内仍有大量朝阳微面（远处光柱正来自这些浪脊），不能用平均法线硬截断。
float sunReflection(vec3 n, vec3 v, float a2, out float D) {
  vec3 l = uSunDirection;
  vec3 h = normalize(v + l);
  float nv = max(dot(n,v),.005), nl = max(dot(n,l),l.y);
  float nh = max(dot(n,h),0.), vh = max(dot(v,h),0.);
  // 毛细波斜率分布比单一 GGX 更“尖峰 + 长尾”：陡峭的厘米级微面把太阳散到光柱两侧很远。
  D = mix(ggxD(nh, a2), ggxD(nh, a2 + CAPILLARY_TAIL), .5);
  float g2 = a2 + .5 * CAPILLARY_TAIL;
  return D * smithG2(nv, nl, g2) * dielectric(vh,1.,IOR) / (4. * nv);
}

// 水下看到的太阳透射：粗糙介质 BTDF（Walter 2007），i 为空气侧朝太阳，o 为水侧朝眼。
// 返回乘以 cosθi 后的系数，乘太阳辐照度即得到辐亮度；含 η² 辐亮度压缩。
float sunTransmission(vec3 n, vec3 o, float a2, out float D) {
  vec3 i = uSunDirection;
  vec3 ht = -(i + IOR * o);
  float len = length(ht);
  D = 0.;
  if(len < 1e-4) return 0.;
  ht /= len;
  if(ht.y < 0.) ht = -ht;
  float ih = dot(i, ht), oh = dot(o, ht);
  float ni = dot(n, i), no = -dot(n, o);
  if(ih <= 0. || oh >= 0. || ni <= 0. || no <= 0.) return 0.;
  // 已解析浪面之下的未解析斜率近似高斯（Cox–Munk），用 Beckmann 分布：GGX 的长尾会把太阳透射到远离 Snell 像的低仰角处。
  D = beckmannD(max(dot(n, ht), 0.), a2);
  float G = smithG1(ni, a2) * smithG1(no, a2);
  float denom = ih + IOR * oh;
  float ft = ih * abs(oh) / (ni * no) * IOR * IOR * (1. - dielectric(ih, 1., IOR)) * G * D / (denom * denom);
  return ft * ni;
}

// 水体光学（每米）：吸收以红光最强，颗粒散射近乎无色、略偏短波。近岸水体散射较强，光束清晰可见。
const vec3 WATER_ABSORPTION = vec3(.22, .072, .046);
const vec3 WATER_SCATTERING = vec3(.22, .24, .26);
const vec3 WATER_EXTINCTION = WATER_ABSORPTION + WATER_SCATTERING;
// 下行漫射光随深度的衰减系数 Kd。
const vec3 DIFFUSE_ATTENUATION = vec3(.46, .085, .062);

// 多次散射后的平衡辐亮度 L∞：由天空下行光在水体中反复散射形成，朝上最亮、朝下为上行光。
// 角分布上下不对称（Tyler 1960 的湖中实测）：天顶约为水平的十倍，天底约为水平的五分之一。
vec3 waterScatter(vec3 rd, float depth) {
  vec3 horizontal = vec3(.0036, .032, .06);
  float shape = exp(rd.y * (1.95 + .45 * rd.y));
  return horizontal * shape * exp(-DIFFUSE_ATTENUATION * max(depth, 0.));
}

vec3 refractedSunDirection() {
  return -refract(-uSunDirection, vec3(0., 1., 0.), 1. / IOR);
}

// 透射方向对浪面斜率的导数 M = ∂(t.xz/−t.y)/∂∇h（平面海面处取值）。低太阳斜入射时 M 高度各向异性：
// 沿太阳方位的倾斜几乎不改变折射方向，横向倾斜的偏折约为垂直入射的四倍。焦散因此汇成包含光线方向的光片，
// 从水下仰视即由太阳像向下扇开的光束。
mat2 refractionJacobian() {
  vec3 i = -uSunDirection;
  vec3 t0 = refract(i, vec3(0., 1., 0.), 1. / IOR);
  const float e = .01;
  vec3 tx = refract(i, normalize(vec3(-e, 1., 0.)), 1. / IOR);
  vec3 tz = refract(i, normalize(vec3(0., 1., -e)), 1. / IOR);
  vec2 f0 = t0.xz / -t0.y;
  return mat2((tx.xz / -tx.y - f0) / e, (tz.xz / -tz.y - f0) / e);
}

// 焦线处 1/|J| 发散；有限太阳盘与未解析的浪面会把焦线抹开。用 1/√(J²+ε) 平滑饱和（峰值约 3），
// 代替原先在 1/0.12 附近的硬截断：尖峰小、斜率连续，逐步积分时不再因深度抖动在尖峰上跳变而成颗粒。
const float CAUSTIC_SOFTENING = .12;
float focusing(vec2 entry, float depth, float lod, mat2 M) {
  // 与波场同帧更新的曲率缓存（hxx, hzz, hxz）；深度 d 处的面积比 J = I + d·M·H，浪脊（H 负定）聚焦。
  // 焦散强度 1/|J| 的期望约为 1，平面处（J = 1）恰为 1，不引入额外能量。
  vec3 c=textureLod(uCurvature,entry/uLengths.x,lod).rgb+textureLod(uDetailCurvature,entry/uLengths.y,lod+1.).rgb;
  mat2 J=mat2(1.)+clamp(depth,.05,14.)*M*mat2(c.x,c.z,c.z,c.y);
  float det=J[0][0]*J[1][1]-J[0][1]*J[1][0];
  return sqrt(1. + CAUSTIC_SOFTENING) / sqrt(det * det + CAUSTIC_SOFTENING);
}

// 光束强度按参考图 3 校准：同一太阳按单次散射估计的约三倍。仰角 3° 时晴空的直射/漫射水平辐照比约在 0.15–0.8，
// 场景天空取自 LDR 照片、绝对亮度未知；水面闪点按参考图 1 校准且大多已过曝，因此只在水下光束上体现这一比例。
const float BEAM_CALIBRATION = 3.;

// 太阳单次散射光束：沿视线积分，入射点按水中光线方向回溯到海面，焦散调制光柱。
// 每个入射点按当地浪面（长浪 + 细浪的低通斜率）求真实折射方向与透射通量：朝阳的浪面接收的通量是平面的数倍，
// 折射后更接近水平，散射角变小、相函数峰值更高；背阳面没有直射光。光束因此在朝阳浪面下成片出现，
// 并从太阳方位附近向下扇开。所有浪面的平均通量与平面海面按斜率分布积分的结果一致，不引入额外能量。
// 层内变化主要来自焦散随深度 d 的起伏（J = I + d·M·H），分层越细颗粒越少；固定时刻截图中 40 层的高频残差比 26 层低约 16%。
const int BEAM_STEPS = 40;
vec3 sunBeams(vec3 ro, vec3 rd, float maxDist) {
  vec3 lightDir = refractedSunDirection();
  float lengthRay = min(maxDist, 30.);
  // 白噪声抖动，逐帧换种子：交错梯度噪声没有时间累积时会显出斜向网格；固定的白噪声会像镜头上的脏点，
  // 逐帧变化则在播放中被视觉平均。固定物理时刻（截图）仍可复现。
  float jitter = hash12(gl_FragCoord.xy + fract(uTime * 7.23) * 131.);
  vec3 sum = vec3(0.);
  mat2 M = refractionJacobian();
  // 分层采样：第 i 层固定覆盖 [L·(i/N)^k, L·((i+1)/N)^k]，样本在层内抖动、权重为层宽，积分长度恒为 L。
  // （按“与上一样本的距离”加权会让总长度随抖动变化，靠近海面最亮的一段被随机截掉。）
  // 水下仰视时视线十米内就到海面，最亮的一段在远端，均匀分层；近水平的长视线仍让近处层更窄。
  float spacing = mix(1., 2., clamp((lengthRay - 8.) / 16., 0., 1.));
  for(int i=0;i<BEAM_STEPS;i++) {
    float u0 = float(i) / float(BEAM_STEPS), u1 = float(i + 1) / float(BEAM_STEPS);
    float u = (float(i) + jitter) / float(BEAM_STEPS);
    float ds = lengthRay * (pow(u1, spacing) - pow(u0, spacing));
    float s = lengthRay * pow(u, spacing);
    vec3 p = ro + rd * s;
    float depth = max(-p.y, .02);
    float slant = depth / lightDir.y;
    vec2 entry = p.xz + lightDir.xz * slant;
    // 各向同性 LOD：沿扫过方向的各向异性足迹（textureGrad）颗粒并不更少，却使水下帧耗约翻倍，已撤回。
    float lod = clamp(log2(1. + depth * .3), 0., 2.);
    vec2 slope = textureLod(uSurface, entry / uLengths.x, lod + 1.).gb + textureLod(uDetailSurface, entry / uLengths.y, lod + 2.).gb;
    vec3 n = normalize(vec3(-slope.x, 1., -slope.y));
    float cosIn = dot(n, uSunDirection);
    if(cosIn <= 0.) continue;
    vec3 t = refract(-uSunDirection, n, 1. / IOR);
    float mu = dot(rd, -t);
    float phase = .45 * henyeyGreenstein(mu, .94) + .45 * henyeyGreenstein(mu, .8) + .1 * henyeyGreenstein(mu, .3);
    // 单位水平面积的入射通量 cosIn/n.y，除以光线的 |t.y| 得到垂直于光束的辐照度。
    float flux = cosIn / n.y * (1. - dielectric(cosIn, 1., IOR)) / max(-t.y, .2);
    float path = depth / max(-t.y, .2);
    float caustic = focusing(entry, depth, lod, M);
    sum += SUN_IRRADIANCE * flux * phase * caustic * exp(-WATER_EXTINCTION * (s + path)) * ds;
  }
  return sum * WATER_SCATTERING * BEAM_CALIBRATION;
}

// 三维悬浮颗粒：沿视线在若干深度切片中寻找最近的颗粒中心，按点到射线距离成像。
vec3 suspendedParticles(vec3 ro, vec3 rd, float maxDist) {
  vec3 c = vec3(0.);
  vec3 lightDir = refractedSunDirection();
  float forward = .35 + 2.2 * pow(max(dot(rd, lightDir), 0.), 6.);
  for(int i=0;i<8;i++) {
    float d = .6 + float(i) * 1.1 + float(i * i) * .12;
    if(d > maxDist) break;
    vec3 q = ro + rd * d;
    q += vec3(sin(uTime * .11 + float(i)) * .03, uTime * .018, cos(uTime * .09 + float(i)) * .03);
    vec3 cell = floor(q * 1.6);
    vec3 h = vec3(hash12(cell.xy + cell.z * 17.1), hash12(cell.yz + cell.x * 7.3), hash12(cell.zx + cell.y * 3.9));
    if(hash12(cell.xz * 1.31 + cell.y * 5.17 + float(i)) < .9) continue;
    vec3 center = (cell + .1 + .8 * h) / 1.6;
    vec3 toCenter = center - ro;
    float along = dot(toCenter, rd);
    if(along < .3) continue;
    float distanceToRay = length(toCenter - rd * along);
    float radius = mix(.0012, .004, h.x) + along * uPixelAngle * .7;
    float particle = exp(-distanceToRay * distanceToRay / (radius * radius)) * mix(.0012, .004, h.x) / radius;
    c += particle * vec3(.55, .82, .78) * forward * exp(-WATER_EXTINCTION * along) * exp(-max(-center.y, 0.) * .05);
  }
  return c * .35;
}

const float CRITICAL_COS = .66123;  // √(1 − 1/η²)，η = 1.333
// 透射闪点的起伏幅度（1 为完整随机微面）；期望亮度不变，只降低碎点对比。
const float UNDERWATER_GLINT_CONTRAST = .2;
// 太阳透射只解析 ≥ 此尺度（米）的浪面，更细的毛细波并入 Beckmann 粗糙度：总透射能量不变，碎点合成较大的光斑。
const float UNDERWATER_SUN_SCALE = .08;
// 水面下方透射太阳光斑的增益（2026-09-24 用户反馈）：画面上沿的光斑压到 0.6，主光位让给远方日光晕，
// 仍保留由浪面决定的光斑形状与闪点；水上太阳与闪点不受影响。
const float UNDERWATER_CEILING_SUN = .6;
// 对入射余弦 c ~ N(ci, σ²) 求平均透射率 E[T] 与透射加权的平均余弦（6 点 Gauss–Legendre，只积临界角以上）。
// 像素内一部分微面全反射、一部分透射，得到的是两者的面积混合，而不是按平均法线二选一。
void transmissionTap(float c, float w, float ci, float sigma, inout vec2 sum) {
  float d = (c - ci) / sigma;
  float value = w * (1. - dielectric(c, IOR, 1.)) * exp(-.5 * d * d);
  sum += value * vec2(1., c);
}
float normalCdf(float z) { return 1. / (1. + exp(-1.702 * z)); }
vec2 averageTransmission(float ci, float sigma) {
  float lo = max(ci - 3. * sigma, 0.), hi = min(ci + 3. * sigma, 1.);
  float a = max(lo, CRITICAL_COS);
  if(hi <= a + 1e-6) return vec2(0., CRITICAL_COS + 1e-3);
  float m = .5 * (a + hi), r = .5 * (hi - a);
  vec2 sum = vec2(0.);
  transmissionTap(m - .9324695142 * r, .1713244924, ci, sigma, sum);
  transmissionTap(m - .6612093865 * r, .3607615730, ci, sigma, sum);
  transmissionTap(m - .2386191861 * r, .4679139346, ci, sigma, sum);
  transmissionTap(m + .2386191861 * r, .4679139346, ci, sigma, sum);
  transmissionTap(m + .6612093865 * r, .3607615730, ci, sigma, sum);
  transmissionTap(m + .9324695142 * r, .1713244924, ci, sigma, sum);
  float mass = 2.50662827 * sigma * max(normalCdf((hi - ci) / sigma) - normalCdf((lo - ci) / sigma), 1e-6);
  return vec2(clamp(sum.x * r / mass, 0., 1.), sum.x > 1e-8 ? clamp(sum.y / sum.x, CRITICAL_COS + 1e-3, 1.) : CRITICAL_COS + 1e-3);
}
// 远方日光晕（艺术处理，非物理；2026-09-24 用户反馈）：水平镜头下 Snell 太阳像仰角 41.5°，在画面上沿（约 33.3°）之外，
// 画面内的光只从上方射入。用户要求潜入后光位留在远处——与半浸没时水面上的太阳同一画面位置（参考图 2 水下光束也从日面下方扇开）。
// 因此在空气中的太阳方向（仰角 3.2°、方位 24.5°）叠加一团水中前向散射光晕，可理解为朝阳方位远处光束沿长视线累积成的雾光。
// 按本项目的光束相函数，该方向（与 Snell 太阳像约 38°）的单次散射只有画面上沿（约 8°）的 1/25，这里是构图上的取舍。
// 核心：同一太阳经水体滤过（下行到相机深度再加一段散射路程），乘单次散射反照率 σs/σt；
// 外晕：多次散射光场 L∞ 朝太阳方位增亮（青色）。视线越短（很快碰到水面）累积越少。
const float DISTANT_GLOW_CORE_GAIN = 1.4;
const float DISTANT_GLOW_HALO_GAIN = 2.6;
const float DISTANT_GLOW_PATH = 1.5;
// 角尺度（弧度）：亮度按 exp(−θ/w) 衰减（雾中光源的尖峰长尾，而非平顶光斑），核心 w≈4°、外晕 w≈13°；
// 光来自水面，向上铺开 1.5 倍、向下收紧到 0.75 倍。
const vec2 DISTANT_GLOW_WIDTH = vec2(.08, .24);
const vec2 DISTANT_GLOW_VERTICAL = vec2(1.5, .75);
vec3 distantSunGlow(vec3 rd, float depth, float pathLength) {
  vec2 sunFlat = normalize(uSunDirection.xz);
  vec2 rayFlat = normalize(rd.xz + vec2(1e-6, 0.));
  float azimuth = acos(clamp(dot(rayFlat, sunFlat), -1., 1.));
  float elevation = asin(clamp(rd.y, -1., 1.)) - asin(uSunDirection.y);
  elevation /= elevation > 0. ? DISTANT_GLOW_VERTICAL.x : DISTANT_GLOW_VERTICAL.y;
  float theta = sqrt(azimuth * azimuth + elevation * elevation);
  float core = exp(-theta / DISTANT_GLOW_WIDTH.x);
  float halo = exp(-theta / DISTANT_GLOW_WIDTH.y);
  vec3 sun = SUN_IRRADIANCE * exp(-WATER_EXTINCTION * (DISTANT_GLOW_PATH + depth)) * WATER_SCATTERING / WATER_EXTINCTION;
  vec3 water = waterScatter(vec3(1., 0., 0.), depth);
  return (sun * core * DISTANT_GLOW_CORE_GAIN + water * halo * DISTANT_GLOW_HALO_GAIN) * (1. - exp(-WATER_EXTINCTION * pathLength));
}

// 水体消光 K≈0.31/m：30m 外水面的贡献已衰减到 1e-4 以下（远低于 8 位量化的 1/255）。
// 水平镜头下，近水平的仰视视线在平均海面上的距离超过此值时不再求交——这些掠射视线的步进最长（上百次高度采样）。
const float FAR_SURFACE = 30.;
vec3 renderUnderwater(vec3 ro, vec3 rd, out float hitDistance) {
  float depth = max(0., -ro.y);
  float planeDistance = rd.y > 0. ? depth / rd.y : 1e4;
  float t = planeDistance < FAR_SURFACE ? intersectSea(ro, rd, -1.) : -1.;
  vec3 ambient = waterScatter(rd, depth);
  vec3 col = ambient;
  float travelled = 30.;
  hitDistance = 18.;
  if(t <= 0. && rd.y > 0.) {
    // 远处水面：只保留沿视线到平均海面的路径散射，与命中分支同式（水面项已不可见），截断处连续。
    travelled = min(planeDistance, 40.);
    hitDistance = planeDistance;
    vec3 k = WATER_EXTINCTION - DIFFUSE_ATTENUATION * rd.y;
    col = ambient * WATER_EXTINCTION / k * (1. - exp(-k * planeDistance));
  }
  if(t > 0.) {
    travelled = min(t, 40.);
    hitDistance = t;
    vec3 p = ro + rd * t;
    float variance;
    vec3 n = filteredNormal(p.xz, rd, t, variance);
    vec3 o = -rd;
    float ci = max(dot(rd, n), 0.);
    float a2 = .006 + variance;
    // 临界角处透射率是阶跃函数；足迹内斜率近似高斯，入射余弦的标准差 σ = sinθ·√(α²/2)。
    vec2 averaged = averageTransmission(ci, max(sqrt(max(1. - ci * ci, 0.) * a2 * .5), 1e-4));
    float transmittance = averaged.x, ce = averaged.y;
    float F = 1. - transmittance;
    // 透射光来自入射余弦为 ce 的那部分微面：同一入射面内把视线转到 ce 后再折射。
    vec3 tangent = rd - n * ci;
    tangent = dot(tangent, tangent) > 1e-10 ? normalize(tangent) : vec3(1., 0., 0.);
    vec3 exitDirection = refract(ce * n + sqrt(1. - ce * ce) * tangent, -n, IOR);
    vec3 reflectionDirection = reflect(rd, -n);
    // 超临界角全反射：看到的是下方水体（以及另一道浪的背面），形成揉皱锡箔般的明暗。
    // 反射看到的是水面处的上行光：渐近光场各方向都按 exp(−Kd·z) 衰减，取水面深度而非相机深度。
    vec3 reflected = waterScatter(reflectionDirection, 0.);
    if(F > .2 && reflectionDirection.y > .02) {
      float bounce = intersectSea(p - n * .012, reflectionDirection, -1.);
      if(bounce > .02 && bounce < 24.) {
        vec3 bp = p - n * .012 + reflectionDirection * bounce;
        vec3 bn = waveNormal(bp.xz, t + bounce);
        vec3 exitRay = refract(reflectionDirection, -bn, IOR);
        float bF = dielectric(max(dot(reflectionDirection, bn), 0.), IOR, 1.);
        if(dot(exitRay, exitRay) > .1) reflected = mix(reflected, exitEnvironment(normalize(exitRay), false, 3.) * (1. - bF) * IOR * IOR, exp(-WATER_EXTINCTION.g * bounce) * .8);
      }
    }
    vec3 transmitted = vec3(0.);
    if(transmittance > 0. && dot(exitDirection, exitDirection) > .1) {
      // Snell 窗内的天空透射；η² 为进入致密介质时的辐亮度压缩。粗糙度决定天空 mip。
      float lod = clamp(log2(715. * sqrt(a2) * .8 + 1.), 0., 7.);
      transmitted = exitEnvironment(normalize(exitDirection), false, lod) * transmittance * IOR * IOR;
    }
    // 水下太阳：同一世界太阳经每个微面的 Snell 折射，得到由波面决定的透射光斑与闪点。
    float D;
    float sunVariance;
    vec3 sunNormal = filteredNormal(p.xz, rd, t, UNDERWATER_SUN_SCALE, sunVariance);
    float sunCoefficient = sunTransmission(sunNormal, o, .006 + sunVariance + SUN_OUTER_RADIUS * SUN_OUTER_RADIUS, D);
    if(sunCoefficient > 1e-6) sunCoefficient *= mix(1., glintFactor(p.xz, rd, t, n, glintProbability(D)), UNDERWATER_GLINT_CONTRAST);
    vec3 atSurface = transmitted + reflected * F + SUN_IRRADIANCE * sunCoefficient * UNDERWATER_CEILING_SUN;
    vec3 extinction = exp(-WATER_EXTINCTION * t);
    // 路径散射：沿视线的源项 L∞·exp(−Kd·z) 随上升变亮，积分得 c/(c − Kd·rd.y)·(1 − e^{−(c − Kd·rd.y)t})。
    vec3 k = WATER_EXTINCTION - DIFFUSE_ATTENUATION * rd.y;
    col = atSurface * extinction + ambient * WATER_EXTINCTION / k * (1. - exp(-k * t));
  }
  col += distantSunGlow(rd, depth, travelled);
  col += sunBeams(ro, rd, travelled);
  col += suspendedParticles(ro, rd, travelled);
  return col;
}

vec3 renderAbove(vec3 ro, vec3 rd, out float hitDistance) {
  float t = intersectSea(ro, rd, 1.);
  if(t < 0.) { hitDistance = 1e4; return skyRadiance(rd, true, 0.); }
  hitDistance = t;
  vec3 p = ro + rd * t;
  float variance;
  vec3 n = filteredNormal(p.xz, rd, t, variance);
  vec3 v = -rd;
  // 过滤法线背向相机只可能出现在近处陡峭浪脊的轮廓上；阈值随视线仰角缩放，
  // 远处掠射（平面海面 n·v = |rd.y|）的微面仍然可见，Smith 遮蔽由 G1 统计处理。
  float grazing = max(abs(rd.y), .002);
  float microVisibility = smoothstep(-.1 * grazing, .5 * grazing, dot(n, v));
  if(dot(n, v) < .5 * grazing) n = normalize(n + v * (.5 * grazing - dot(n, v)));
  float nv = max(dot(n, v), .5 * grazing);
  // 未解析毛细波 + 像素足迹内的斜率方差（LEAN）：远处方差变大，太阳反射自然汇成光柱。
  float a2 = .018 + variance;
  // 像素内可见微面偏向朝着相机（投影面积加权）：单向斜率方差 σ²，掠射时平均可见斜率约 σ²/(tanθ+0.8σ)。
  // 远处的反射光线因此指向更高、更蓝的天空，平均菲涅耳也低于平均法线处的掠射值。
  float slopeVariance = .5 * a2;
  float viewTangent = nv / sqrt(max(1. - nv * nv, 1e-4));
  vec3 towardViewer = normalize(v - n * dot(n, v) + vec3(0., 1e-4, 0.));
  vec3 visibleNormal = normalize(n + towardViewer * slopeVariance / (viewTangent + .8 * sqrt(slopeVariance)));
  vec3 reflected = reflect(rd, visibleNormal);
  float F = dielectric(sqrt(nv * nv + .5 * a2), 1., IOR);
  float lod = clamp(log2(715. * 2. * sqrt(a2 * .5) + 1.), 0., 7.);
  // 低仰角的反射光线会被前方浪脊挡住，看到的是另一道浪的暗面。
  float reflectedVisibility = smoothstep(-.06, .12, reflected.y);
  vec3 sky = mix(vec3(.004, .018, .026), exitEnvironment(reflected, false, lod), reflectedVisibility);
  // 水体上涌光很弱；背光浪脊的薄处透出蓝绿色。
  vec3 body = vec3(.0012, .008, .012);
  float crest = smoothstep(-.10, .45, p.y);
  float backlight = pow(max(dot(v, -uSunDirection) * .5 + .5, 0.), 5.);
  body += vec3(.002, .030, .030) * crest * backlight * (1. - F);
  vec3 col = mix(body, sky, F);
  float D;
  float sunA2 = a2 + SUN_OUTER_RADIUS * SUN_OUTER_RADIUS;
  float spec = sunReflection(n, v, sunA2, D) * microVisibility;
  // 远处一个像素覆盖数米海面：求交只命中朝向相机的浪面，其平均法线背离低太阳、
  // 单点阴影光线也几乎总被浪脊挡住；但足迹内同时存在既可见又受光的浪顶，光柱正来自它们。
  // 远场因此改用相对平均海平面的统计斜率分布（局部倾斜并入方差），遮蔽与阴影都由 Smith 统计给出。
  float farField = smoothstep(1.5, 10., t);
  float resolvedShadow = 1. - smoothstep(2., 10., t);
  if(spec > 1e-6 && resolvedShadow > 0.) {
    // 近处浪形已解析：低角度太阳会被前方浪脊遮挡。
    float sunVisibility = 1.;
    for(int i=0;i<6;i++) {
      float distanceAlongSun = .15 * pow(1.9, float(i));
      vec3 samplePoint = p + uSunDirection * distanceAlongSun;
      float clearance = samplePoint.y - seaHeight(samplePoint.xz, t * uPixelAngle);
      sunVisibility = min(sunVisibility, smoothstep(-.03, .04 + distanceAlongSun * .004, clearance));
    }
    spec *= mix(1., sunVisibility, resolvedShadow);
  }
  if(farField > 0.) {
    float Ds;
    float statistical = sunReflection(vec3(0., 1., 0.), v, max(sunA2, .018 + totalSlopeVariance() + SUN_OUTER_RADIUS * SUN_OUTER_RADIUS), Ds);
    spec = mix(spec, statistical, farField);
    D = mix(D, Ds, farField);
  }
  if(spec > 1e-6) spec *= glintFactor(p.xz, rd, t, n, glintProbability(D));
  col += SUN_IRRADIANCE * spec;
  // 远景大气透视与同一环境地平线收敛。
  float haze = 1. - exp(-t * .0009);
  col = mix(col, skyRadiance(normalize(vec3(rd.x, .004, rd.z)), false) * .78, haze);
  return col;
}

void main() {
  vec2 uv=vUv;
  vec3 ray=viewRay(uv);
  vec3 port=lensPoint(uv);
  float signedHeight=port.y-seaHeight(port.xz);
  float edge=max(fwidth(signedHeight)*1.4,.0012);
  float underwater=1.-smoothstep(-edge,edge,signedHeight);
  vec3 col;
  float aboveDistance=1e4, belowDistance=18.;
  if(signedHeight>edge) col=renderAbove(port,ray,aboveDistance);
  else if(signedHeight<-edge) col=renderUnderwater(port,ray,belowDistance);
  else {
    vec3 a=port; a.y=seaHeight(port.xz)+.003;
    vec3 b=port; b.y=seaHeight(port.xz)-.003;
    col=mix(renderAbove(a,ray,aboveDistance),renderUnderwater(b,ray,belowDistance),underwater);
  }
  col=waterlineOptics(col,uv,port,ray,signedHeight);
  // 薄透镜弥散圈：按真实交点距离；罩面上的水膜/泡沫位于罩面半径处。
  float distanceToSubject=mix(aboveDistance,belowDistance,underwater);
  distanceToSubject=mix(distanceToSubject,uPortRadius,lensContact);
  float coc=min(uFocus.y*abs(1./max(distanceToSubject,.05)-1./uFocus.x),uFocus.z);
  gl_FragColor=vec4(max(col,vec3(0.)),coc);
}
