// 镜头端口与 FFT 波场接触处的薄水膜、破碎泡沫及微气泡。
// 所有量均以米为基准；仅作用于真实水线附近，远离水线直接返回。
// 此层不改变宏观界面的交点，也不创建另一盏光源或独立的太阳贴图。
float wlNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash12(cell), hash12(cell + vec2(1., 0.)), f.x),
             mix(hash12(cell + vec2(0., 1.)), hash12(cell + vec2(1.)), f.x), f.y);
}

float wlPatch(vec2 p) {
  // 多尺度纹理只控制水膜厚度和泡沫破碎程度，不代替实际海浪。
  return .57 * wlNoise(p) + .29 * wlNoise(p * 2.17 + 13.7)
       + .14 * wlNoise(p * 4.91 - 8.3);
}

vec2 wlBubbleRims(vec2 p, float footprint, vec2 lightDirection, float activity) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  float rings = 0.;
  float highlights = 0.;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 id = cell + offset;
      float seed = hash12(id + 51.2);
      vec2 center = .12 + .76 * vec2(hash12(id + 7.3), hash12(id - 18.1));
      vec2 q = local - offset - center;
      // 半径、椭圆率及可见弧均随泡变化，避免均匀圆点或规则网格。
      q.x += q.y * (hash12(id - 6.2) - .5) * .5;
      q *= vec2(mix(.82, 1.37, hash12(id + 32.)), mix(.9, 1.5, seed));
      float radius = mix(.09, .265, seed * seed);
      float distanceToRim = abs(length(q) - radius);
      float width = max(.014, footprint * .55);
      float ring = 1. - smoothstep(width, width * 1.7, distanceToRim);
      float occupied = smoothstep(.79 - activity * .17, .96 - activity * .12,
                                  hash12(id + 103.));
      float arc = .025 + .975 * pow(max(dot(normalize(q + .00001), lightDirection), 0.), 4.);
      float resolved = smoothstep(footprint * .75, footprint * 2.5, radius);
      rings = max(rings, ring * occupied * resolved * (.08 + .92 * arc));
      highlights = max(highlights, ring * occupied * resolved * arc * arc);
    }
  }
  return vec2(rings, highlights);
}

vec3 waterlineOptics(vec3 color, vec2 uv, vec3 port, vec3 ray, float portHeight) {
  // 接触带参数以 0.85m 罩面标定；换算到当前罩面半径，使水膜在画面上的角宽不变。
  float signedHeight = portHeight * (.85 / uPortRadius);
  // 导数在分支外计算；不在离水线很远的片元中执行纹理采样和气泡邻域查询。
  float edgeFootprint = max(fwidth(signedHeight), .0003);
  float screenFootprint = max(1.7 * tan(uFov * .5) / uResolution.y, .00025);
  if (signedHeight < -.050 || signedHeight > .035) return color;

  vec3 displacement = rawWave(port.xz);
  // 反解水平位移后的材质坐标随实际波场运动，泡沫不会贴在屏幕上。
  vec2 material = materialCoordinate(port.xz);
  vec3 curvature = textureLod(uCurvature, port.xz / uLengths.x, 0.).rgb
                 + textureLod(uDetailCurvature, port.xz / uLengths.y, 0.).rgb;
  float crestCurvature = max(0., -(curvature.x + curvature.y));
  float crest = 1. - exp(-crestCurvature * .82);
  float folding = clamp(length(vec2(curvature.x - curvature.y, 2. * curvature.z)) * .24, 0., 1.);
  float breaking = clamp(crest * .84 + folding * .23, 0., 1.);

  // 近平视时端口的 z 几乎不随像素纵向变化；只采 xz 会把噪声拉成竖条。
  // 改用随波平流的切向坐标和真实水面高度差，接触带内两轴均有独立细节。
  vec2 contactCoordinate = vec2(material.x + material.y * .31,
                                signedHeight + material.y * .035);
  vec2 contactWarp = vec2(wlNoise(contactCoordinate * 31. + 4.2),
                          wlNoise(contactCoordinate.yx * 37. - 8.1)) - .5;
  float filmPatch = wlPatch(contactCoordinate * 43. + contactWarp * .65);
  float smallPatch = wlNoise(contactCoordinate * 167. + contactWarp * 1.8
                            + vec2(displacement.y * .7, -uTime * .023));
  float thickness = .0025 + .0030 * filmPatch + .001 * breaking;
  float distanceFromFilm = signedHeight + .0018 + (smallPatch - .5) * .002;
  float film = 1. - smoothstep(thickness * .24, thickness * 1.35 + edgeFootprint,
                                abs(distanceFromFilm));
  float envelope = smoothstep(-.050, -.041, signedHeight)
                 * (1. - smoothstep(.026, .035, signedHeight));

  // 弯月面法线取同一波场，再在毫米级接触截面中向镜头方向弯曲。
  const float e = .06;
  vec2 slope = vec2(seaHeight(port.xz + vec2(e, 0.)) - seaHeight(port.xz - vec2(e, 0.)),
                    seaHeight(port.xz + vec2(0., e)) - seaHeight(port.xz - vec2(0., e))) / (2. * e);
  vec3 seaNormal = normalize(vec3(-slope.x, 1., -slope.y));
  vec3 facingNormal = dot(seaNormal, -ray) < 0. ? -seaNormal : seaNormal;
  float section = clamp(distanceFromFilm / max(thickness, .001), -1., 1.);
  float meniscusBend = (1. - section * section) * (.10 + filmPatch * .07);
  vec3 filmNormal = normalize(mix(facingNormal, -ray, meniscusBend));
  float nv = max(dot(filmNormal, -ray), .025);
  float fresnel = dielectric(nv, 1., IOR);
  vec3 reflectedDirection = reflect(ray, filmNormal);
  vec3 reflected = skyRadiance(reflectedDirection, false);

  // 薄膜采用 Snell 方向及 Beer–Lambert 吸收。输入已经是主射线的渲染结果，
  // 这里仅作接触带的环境透射近似；不重复追踪整条海面/水下射线。
  vec3 transmittedDirection = refract(ray, filmNormal, 1. / IOR);
  vec3 transmittedEnvironment = skyRadiance(normalize(transmittedDirection), false);
  vec3 absorption = exp(-vec3(.29, .080, .035) * (thickness * 2.6 / nv));
  float environmentAmount = smoothstep(-.005, .012, signedHeight) * .025;
  vec3 transmission = mix(color, transmittedEnvironment, environmentAmount) * absorption;
  vec3 filmColor = mix(transmission, reflected * .62, fresnel * .18);
  // 连续膜只作低权重透射修正，不用环境反射给整条水线描边。
  float filmCoverage = .13 + .21 * smoothstep(.38, .75, filmPatch);
  color = mix(color, filmColor, film * envelope * filmCoverage);

  // 在具有负高度曲率的波峰上聚集泡沫，按材质噪声碎裂成岛状。
  float islands = smoothstep(.49, .72, filmPatch + .075 * smallPatch);
  float foamBand = exp(-pow((signedHeight + .004 + (filmPatch - .5) * .010) /
                           (.0055 + .0065 * breaking), 2.));
  float foamGrain = smoothstep(.52, .78, wlNoise(contactCoordinate * 293.
                              + contactWarp * 2.6 + vec2(smallPatch * .7, 0.)));
  // 提升的只是离散泡沫覆盖；连续膜和环境反射权重保持不变。
  float foam = foamGrain * islands * foamBand * (.14 + .82 * breaking) * envelope;
  float lambert = max(dot(seaNormal, uSunDirection), 0.);
  vec3 foamRadiance = skyRadiance(seaNormal, false) * .17
                   + vec3(.37, .46, .45) * (.18 + .6 * lambert);
  color = mix(color, foamRadiance, clamp(foam, 0., .64));
  // 罩面上的水膜与泡沫位于罩面半径处，景深按此距离成像。
  lensContact = clamp(max(film * envelope * .8, foam * 1.6), 0., 1.);

  // 微气泡位于水线下侧的薄层，随波场位移而动，并只在泡沫聚集区较密。
  vec2 bubblePosition = contactCoordinate * 143. + contactWarp * 1.3;
  vec2 projectedSun = normalize(vec2(uSunDirection.x,
                              uSunDirection.y * cos(uPitch) + uSunDirection.z * sin(uPitch)) + .00001);
  float bubbleFootprint = max(screenFootprint, edgeFootprint) * 143.;
  vec2 bubbles = wlBubbleRims(bubblePosition, bubbleFootprint, projectedSun, breaking);
  float bubbleBand = smoothstep(-.047, -.034, signedHeight)
                   * (1. - smoothstep(-.003, .005, signedHeight));
  float cluster = smoothstep(.42, .72, wlNoise(contactCoordinate * 49. + contactWarp + 4.7));
  float bubbleStrength = bubbleBand * cluster * (.11 + .44 * breaking) * envelope;
  color += bubbles.x * bubbleStrength * vec3(.065, .16, .17);
  color += bubbles.y * bubbleStrength * vec3(.31, .27, .18) * (.12 + .7 * lambert);

  // 所有眩光严格来自固定太阳方向；只在弯曲薄膜满足反射方向时出现。
  float sunAlignment = max(dot(reflectedDirection, uSunDirection), 0.);
  float glint = pow(sunAlignment, 420.) * (.08 + .92 * fresnel);
  float glintCoverage = smoothstep(.49, .78, smallPatch);
  color += vec3(2.1, 1.6, .89) * glint * film * envelope * glintCoverage;
  return color;
}
