//--------------------- Step 1: Importing and Pre-Processing --------------------------------

/*************************************************
 * UK 葡萄园选址 — 数据预处理脚本封装
 * 每个模块都分为“计算影像”和“基于阈值生成掩膜”两部分
 *************************************************/

//—— 1. 定义英国边界（ROI） ——//
/**
 * 返回一个 FeatureCollection，仅包含英国国界
 */
function getUKBoundary() {
    return ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017")
             .filter(ee.Filter.eq("country_na", "United Kingdom"));
  }
  
  
  //—— 2. GST: 生长季平均气温 ——//
  // 2.1 计算 GST
  /**
   * computeGST(year):
   * - 加载 TerraClimate 全年数据
   * - 筛选生长季（4–10月），计算每月平均温度 tmean
   * - 对所有生长季 tmean 取平均，得到 GST（°C）
   */
  function computeGST(year) {
    var bc = UK;
    var tc = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
                 .filterBounds(bc)
                 .filterDate(year + "-01-01", year + "-12-31")
                 .filter(ee.Filter.calendarRange(4, 10, 'month'))
                 .map(function(img) {
                   var tmx = img.select("tmmx").divide(10);
                   var tmn = img.select("tmmn").divide(10);
                   return img.addBands(tmx.add(tmn).divide(2).rename("tmean"));
                 });
    var gst = tc.select("tmean").mean().clip(bc).rename("GST");
    return gst;
  }
  // 2.2 根据 GST 阈值生成掩膜
  /**
   * maskGST(gst, minG, maxG):
   * - 输入 GST 影像，设定下限 minG、上限 maxG
   * - 返回布尔影像：minG ≤ GST ≤ maxG
   */
  function maskGST(gst, minG, maxG) {
    return gst.gte(minG).and(gst.lte(maxG));
  }
  
  //—— 3. GDD: 生长积温 ——//
  // 3.1 计算 GDD
  /**
   * computeGDD(year, baseTemp, daysPerMonth):
   * - 加载生长季同 TerraClimate 数据
   * - 用 tmean = (tmmx + tmmn)/2 计算月均温
   * - 每月积温 GDD_month = max(0, tmean - baseTemp) × daysPerMonth
   * - 对所有月度 GDD 求和，得到生长季总积温 GDD（°C·days）
   */
  function computeGDD(year, baseTemp, daysPerMonth) {
    var bc = UK;
    var tc = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
                 .filterBounds(bc)
                 .filterDate(year + "-01-01", year + "-12-31")
                 .filter(ee.Filter.calendarRange(4, 10, 'month'))
                 .select(["tmmx", "tmmn"])
                 .map(function(img) {
                   var tmean = img.select("tmmx").divide(10)
                                  .add(img.select("tmmn").divide(10))
                                  .divide(2);
                   return tmean.subtract(baseTemp).max(0)
                               .multiply(daysPerMonth)
                               .rename("GDD")
                               .copyProperties(img, img.propertyNames());
                 });
    return tc.sum().clip(bc).rename("GDD");
  }
  // 3.2 根据 GDD 阈值生成掩膜
  /**
   * maskGDD(gdd, minD, maxD):
   * - 输入 GDD 影像，设定下限 minD、上限 maxD
   * - 返回布尔影像：minD ≤ GDD ≤ maxD
   */
  function maskGDD(gdd, minD, maxD) {
    return gdd.gte(minD).and(gdd.lte(maxD));
  }
  
  //—— 4. GSP: 生长季降水量 ——//
  // 4.1 计算 GSP
  /**
   * computeGSP(year):
   * - 加载 TerraClimate 生长季（4–10月）pr 波段
   * - 对月度降水量累加，得到生长季总降水量 GSP（mm）
   */
  function computeGSP(year) {
    var bc = UK;
    var gsp = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
                 .filterBounds(bc)
                 .filterDate(year + "-01-01", year + "-12-31")
                 .filter(ee.Filter.calendarRange(4, 10, 'month'))
                 .select("pr")
                 .sum()
                 .clip(bc)
                 .rename("GSP");
    return gsp;
  }
  // 4.2 根据 GSP 阈值生成掩膜
  /**
   * maskGSP(gsp, minP, maxP):
   * - 输入 GSP 影像，设定下限 minP、上限 maxP
   * - 返回布尔影像：minP ≤ GSP ≤ maxP
   */
  function maskGSP(gsp, minP, maxP) {
    return gsp.gte(minP).and(gsp.lte(maxP));
  }
  
  //—— 5. FlavorHours: 风味酶活性累计小时数 ——//
  // 5.1 计算 FlavorHours
  /**
   * computeFlavorHours(startDate, endDate, tMin, tMax):
   * - 加载 ERA5-Land Hourly 温度数据（K），转为 °C
   * - 筛选 tMin ≤ temp ≤ tMax，并累加小时数
   */
  function computeFlavorHours(startDate, endDate, tMin, tMax) {
    var bc = UK;
    var era5 = ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY")
                 .filterBounds(bc)
                 .filterDate(startDate, endDate)
                 .select("temperature_2m")
                 .map(function(img) {
                   return img.subtract(273.15).rename("T");
                 })
                 .map(function(img) {
                   return img.gte(tMin).and(img.lte(tMax)).rename("flag");
                 });
    return era5.sum().clip(bc).rename("FlavorHours");
  }
  // 5.2 根据 FlavorHours 阈值生成掩膜
  /**
   * maskFlavorHours(fh, threshold):
   * - 返回布尔影像：FlavorHours ≥ threshold
   */
  function maskFlavorHours(fh, threshold) {
    return fh.gte(threshold);
  }
  
  //—— 6. SoilPH: 土壤 pH ——//
  // 6.1 计算 SoilPH
  /**
   * computeSoilPH():
   * - 加载 OpenLandMap pH 数据
   * - 选择表层 b0 波段，除以10得到真实 pH
   */
  function computeSoilPH() {
    var bc = UK;
    return ee.Image("OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02")
             .select("b0").divide(10)
             .rename("soilPH").clip(bc);
  }
  // 6.2 根据 SoilPH 阈值生成掩膜
  /**
   * maskSoilPH(ph, minPH, maxPH):
   * - 返回布尔影像：minPH ≤ soilPH ≤ maxPH
   */
  function maskSoilPH(ph, minPH, maxPH) {
    return ph.gte(minPH).and(ph.lte(maxPH));
  }
  
  var UK = getUKBoundary();
  Map.centerObject(UK, 6);
  Map.addLayer(UK, {color: 'red', width: 2}, "UK Boundary");
  
  //—— 主流程：调用各模块 ——//
  var year = '2024';
  
  // GST 模块
  var gst = computeGST(year);
  Map.addLayer(gst, {min:10, max:20, palette:['blue','green','yellow','red']}, 'GST');
  Map.addLayer(maskGST(gst,14.1,15.5).updateMask(maskGST(gst,14.1,15.5)), {palette:['green']}, 'GST Suitability');
  
  // GDD 模块
  var gdd = computeGDD(year, 10, 30);
  Map.addLayer(gdd, {min:500, max:1500, palette:['white','red']}, 'GDD');
  Map.addLayer(maskGDD(gdd,974,1223).updateMask(maskGDD(gdd,974,1223)), {palette:['green']}, 'GDD Suitability');
  
  // GSP 模块
  var gsp = computeGSP(year);
  Map.addLayer(gsp, {min:200, max:700, palette:['white','blue']}, 'GSP');
  Map.addLayer(maskGSP(gsp,273,449).updateMask(maskGSP(gsp,273,449)), {palette:['blue']}, 'GSP Suitability');
  
  // FlavorHours 模块
  var fh = computeFlavorHours('2024-07-20','2024-09-20',16,22);
  Map.addLayer(fh, {min:0,max:1000,palette:['white','orange']}, 'FlavorHours');
  Map.addLayer(maskFlavorHours(fh,800).updateMask(maskFlavorHours(fh,800)), {palette:['orange']}, 'FlavorHours Suitability');
  
  // Soil pH 模块
  var ph = computeSoilPH();
  Map.addLayer(ph, {min:4,max:8,palette:['#d7191c','#fdae61','#ffffbf','#abdda4','#2b83ba']}, 'Soil pH');
  Map.addLayer(maskSoilPH(ph,6.8,7.2).updateMask(maskSoilPH(ph,6.8,7.2)), {palette:['00FF00'],min:6.8,max:7.2}, 'Soil pH Suitability');
  
  
  
  
  
  // =====================================================
  // 英国葡萄种植适宜性分析（2024年）
  // 数据处理与分析内容：
  // - 利用 LANDSAT 8 计算 NDVI、NDWI、NDMI 指数（渐变可视化）
  // - 提取坡度（0–10°）、高程（50–220m）
  // - 累加 ERA5 年太阳辐射（≥ 2700 MJ/m²）
  // - 筛选适宜葡萄种植的土地类型
  // =====================================================
  
  // ===================== 参数设置 =====================
  var startDate = ee.Date('2024-01-01');
  var endDate = ee.Date('2024-12-31');
  var suitableCodes = [1, 2, 3, 4, 5, 6, 7, 10, 12];  // 可种葡萄的地类编码
  
  // ===================== 地理边界设置 =====================
  var countries = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017");
  var UK_boundary = countries.filter(ee.Filter.eq("country_na", "United Kingdom"));
  Map.centerObject(UK_boundary, 6);
  
  
  // ===================== 通用函数封装 =====================
  // 添加 NDVI, NDWI, NDMI
  function addIndices(image) {
    var sr = image.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'])
                  .multiply(0.0000275).add(-0.2);
    var ndvi = sr.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
    var ndwi = sr.normalizedDifference(['SR_B3', 'SR_B5']).rename('NDWI');
    var ndmi = sr.normalizedDifference(['SR_B5', 'SR_B6']).rename('NDMI');
    return image.addBands([ndvi, ndwi, ndmi]);
  }
  
  // 创建掩膜（支持 gt/lt/between）
  function createMask(image, bandName, operator, threshold) {
    var band = image.select(bandName);
    if (operator === 'gt') return band.gt(threshold);
    if (operator === 'lt') return band.lt(threshold);
    if (operator === 'between') return band.gte(threshold[0]).and(band.lte(threshold[1]));
  }
  
  // 土地利用筛选
  function getSuitableLandcover(image, codes) {
    var mask = image.remap(codes, ee.List.repeat(1, codes.length)).rename('suitable');
    return mask.selfMask();
  }
  
  
  // ===================== 模块 1：葡萄园数据 =====================
  var existing_vineyards = ee.FeatureCollection("projects/ee-cesong333/assets/existing_vineyards");
  Map.addLayer(existing_vineyards, {color: 'purple'}, '现有葡萄园');
  
  
  // ===================== 模块 2：植被水分指数（渐变可视化） =====================
  var l8 = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
    .filterBounds(UK_boundary)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.lt('CLOUD_COVER', 60))
    .map(addIndices);
  
  var median = l8.median().clip(UK_boundary);
  
  // 可视化 NDVI（绿色渐变）
  Map.addLayer(median.select('NDVI'), {
    min: 0,
    max: 1,
    palette: ['white', 'lightgreen', 'green']
  }, 'NDVI');
  
  // 可视化 NDWI（蓝色渐变）
  Map.addLayer(median.select('NDWI'), {
    min: -0.5,
    max: 0.5,
    palette: ['white', 'lightblue', 'blue']
  }, 'NDWI');
  
  // 可视化 NDMI（橙色渐变）
  Map.addLayer(median.select('NDMI'), {
    min: -0.5,
    max: 1,
    palette: ['white', 'orange', 'darkred']
  }, 'NDMI');
  
  
  // ===================== 模块 3：坡度分析（0–10°） =====================
  var dem = ee.Image('USGS/SRTMGL1_003');
  var slope = ee.Terrain.slope(dem);
  
  var slopeVis = {
    min: 0,
    max: 10,
    palette: ['lightblue', 'green', 'darkgreen']
  };
  
  Map.addLayer(slope.clip(UK_boundary), slopeVis, '坡度 Slope (0–10°)');
  
  
  // ===================== 模块 4：高程分析（50–220m） =====================
  var elevation = dem.select('elevation');
  var elevationMask = createMask(elevation, 'elevation', 'between', [50, 220]);
  var elevationFiltered = elevation.updateMask(elevationMask);
  
  var elevationVis = {
    min: 50,
    max: 220,
    palette: ['lightblue', 'yellow', 'green']
  };
  
  Map.addLayer(elevationFiltered.clip(UK_boundary), elevationVis, '高程 Elevation (50–220m)');
  
  
  // ===================== 模块 5：年太阳辐射（≥ 2700 MJ/m²） =====================
  var era5 = ee.ImageCollection('ECMWF/ERA5_LAND/MONTHLY_AGGR')
    .filterDate(startDate, endDate)
    .select('surface_net_solar_radiation_sum');
  
  var annualRadiation = era5.sum().divide(1e6);
  var radiationMask = createMask(annualRadiation, 'surface_net_solar_radiation_sum', 'gt', 2700);
  var radiationFiltered = annualRadiation.updateMask(radiationMask);
  
  var radiationVis = {
    min: 2700,
    max: 6000,
    palette: ['white', 'yellow', 'orange', 'red']
  };
  
  Map.addLayer(radiationFiltered.clip(UK_boundary), radiationVis, '太阳辐射 ≥ 2700 MJ/m²');
  
  
  // ===================== 模块 6：土地利用筛选 =====================
  var landcover = ee.Image('projects/ee-cesong333/assets/Land_Cover_Map_10m');
  var suitableLand = getSuitableLandcover(landcover, suitableCodes);
  
  Map.addLayer(suitableLand, {palette: ['green']}, '适宜土地 Suitable Land for Grapes');
  
  
  
  // ===================== step2： =====================
  
  // ---- 1. 加载英国行政区划数据 ----
  var ukLevel1 = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level1")
    .filter(ee.Filter.eq('ADM0_NAME', 'U.K. of Great Britain and Northern Ireland'));
    
  var ukLevel2 = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level2")
    .filter(ee.Filter.eq('ADM0_NAME', 'U.K. of Great Britain and Northern Ireland'));
  
  // 使用实际的行政区划边界定义区域
  var regions = {};
  
  // 使用实际的行政区划边界定义英国各区域，分割为适合计算的较小区域
  // 英格兰南部各郡
  regions['肯特郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Kent')).geometry();
  regions['东萨塞克斯'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'East Sussex')).geometry();
  regions['西萨塞克斯'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'West Sussex')).geometry();
  regions['萨里郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Surrey')).geometry();
  regions['汉普郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Hampshire')).geometry();
  regions['伦敦'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Greater London')).geometry();
  regions['伯克郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Berkshire')).geometry();
  regions['埃塞克斯郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Essex')).geometry();
  regions['牛津郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Oxfordshire')).geometry();
  regions['白金汉郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Buckinghamshire')).geometry();
  
  // 英格兰西南部各郡
  regions['康沃尔郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Cornwall')).geometry();
  regions['德文郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Devonshire')).geometry();
  regions['多塞特郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Dorsetshire')).geometry();
  regions['萨默塞特郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Somersetshire')).geometry();
  regions['威尔特郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Wiltshire')).geometry();
  regions['格洛斯特郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Gloucestershire')).geometry();
  
  // 英格兰东部各郡
  regions['剑桥郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Cambridgeshire')).geometry();
  regions['萨福克郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Suffolk')).geometry();
  regions['诺福克郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Norfolkshire')).geometry();
  regions['林肯郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Lincolnshire')).geometry();
  
  // 英格兰中部各郡
  regions['赫特福德郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Hertfordshire')).geometry();
  regions['贝德福德郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Bedfordshire')).geometry();
  regions['北安普顿郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Northamptonshire')).geometry();
  regions['莱斯特郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Leicestershire')).geometry();
  regions['沃里克郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Warwickshire')).geometry();
  regions['西米德兰兹'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'West Midlands')).geometry();
  regions['斯塔福德郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Staffordshire')).geometry();
  regions['德比郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Derbyshire')).geometry();
  regions['诺丁汉郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Nottinghamshire')).geometry();
  
  // 英格兰西北部各郡
  regions['柴郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Cheshire')).geometry();
  regions['大曼彻斯特'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Greater Manchest')).geometry();
  regions['默西塞德'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Merseyside')).geometry();
  regions['兰开夏郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Lancashire')).geometry();
  regions['坎布里亚郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Cumbria')).geometry();
  
  // 约克郡及东北部各郡
  regions['北约克郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'North Yorkshire')).geometry();
  regions['西约克郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'West Yorkshire')).geometry();
  regions['南约克郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'South Yorkshire')).geometry();
  regions['亨伯赛德'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Humberside')).geometry();
  regions['达勒姆郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Durham')).geometry();
  regions['泰恩和威尔'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Tyne and Wear')).geometry();
  regions['诺森伯兰郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Northumberland')).geometry();
  regions['克利夫兰'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Cleveland')).geometry();
  
  // 威尔士各区域（小块）
  regions['克赖德'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Clwyd')).geometry();
  regions['格温内思'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Gwynedd')).geometry();
  regions['迪菲德'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Dyfed')).geometry();
  regions['鲍伊斯'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Powys')).geometry();
  regions['南格拉摩根'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'South Glamorgan')).geometry();
  regions['中格拉摩根'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Mid Glamorgan')).geometry();
  regions['西格拉摩根'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'West Glamorgan')).geometry();
  regions['格温特'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Gwent')).geometry();
  
  // 苏格兰各区域（小块）
  regions['边区'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Borders')).geometry();
  regions['中央区'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Central')).geometry();
  regions['邓弗里斯和加洛韦'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Dumfries and Gal')).geometry();
  regions['法伊夫'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Fyfe')).geometry();
  regions['格兰皮恩'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Grampian')).geometry();
  regions['高地'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Highland')).geometry();
  regions['洛锡安'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Lothian')).geometry();
  regions['斯特拉斯克莱德'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Strathclyde')).geometry();
  regions['泰赛德'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Tayside')).geometry();
  
  // 北爱尔兰各区域（小块）
  regions['贝尔法斯特'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Belfast')).geometry();
  regions['安特里姆'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Antrim')).geometry();
  regions['唐郡'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Down')).geometry();
  regions['阿玛'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Armagh')).geometry();
  regions['泰隆'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Tyrone')).geometry();
  regions['菲尔马纳'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Fermanagh')).geometry();
  regions['伦敦德里'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Londonderry')).geometry();
  

  // 初始设置为英格兰东南部
  var analysisRegion = regions['伦敦德里'];
  
  // 显示英国边界
  var UK = ukLevel1.geometry();
  Map.addLayer(UK, {color: 'red', width: 1}, "英国边界", false);
  
  // ---- 2. 功能函数定义 ----
  // 计算生长季平均温度（GST）
  function computeGST(year) {
    var tc = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
                 .filterDate(year + "-01-01", year + "-12-31")
                 .filter(ee.Filter.calendarRange(4, 10, 'month'))
                 .map(function(img) {
                   var tmx = img.select("tmmx").divide(10);
                   var tmn = img.select("tmmn").divide(10);
                   return img.addBands(tmx.add(tmn).divide(2).rename("tmean"));
                 });
    return tc.select("tmean").mean().rename("GST");
  }
  
  // 生成GST掩膜
  function maskGST(gst, minG, maxG) {
    return gst.gte(minG).and(gst.lte(maxG));
  }
  
  // 计算生长积温（GDD）
  function computeGDD(year, baseTemp, daysPerMonth) {
    var tc = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
                 .filterDate(year + "-01-01", year + "-12-31")
                 .filter(ee.Filter.calendarRange(4, 10, 'month'))
                 .select(["tmmx", "tmmn"])
                 .map(function(img) {
                   var tmean = img.select("tmmx").divide(10)
                                  .add(img.select("tmmn").divide(10))
                                  .divide(2);
                   return tmean.subtract(baseTemp).max(0)
                               .multiply(daysPerMonth)
                               .rename("GDD")
                               .copyProperties(img, img.propertyNames());
                 });
    return tc.sum().rename("GDD");
  }
  
  // 生成GDD掩膜
  function maskGDD(gdd, minD, maxD) {
    return gdd.gte(minD).and(gdd.lte(maxD));
  }
  
  // 计算生长季降水量（GSP）
  function computeGSP(year) {
    var gsp = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
                 .filterDate(year + "-01-01", year + "-12-31")
                 .filter(ee.Filter.calendarRange(4, 10, 'month'))
                 .select("pr")
                 .sum()
                 .rename("GSP");
    return gsp;
  }
  
  // 生成GSP掩膜
  function maskGSP(gsp, minP, maxP) {
    return gsp.gte(minP).and(gsp.lte(maxP));
  }
  
  // 清除地图图层函数
  function clearMapLayers() {
    var layersToRemove = [
      '分析区域',
      '生长季平均温度 (GST)',
      '生长积温 (GDD)',
      '生长季降水量 (GSP)',
      '坡度',
      '基于环境因素的适宜区域',
      '现有葡萄园',
      '葡萄种植适宜性概率',
      '高适宜性区域 (>70%)'
    ];
    
    // 找到所有匹配的图层并移除
    Map.layers().forEach(function(layer) {
      var name = layer.getName();
      if (layersToRemove.indexOf(name) !== -1) {
        Map.remove(layer);
      }
    });
  }
// ===== 1. 独立的机器学习模块 =====

/**
 * 葡萄种植适宜性分析模块 - 核心机器学习功能
 * 
 */
var GrapeML = {
  
  /**
   * 计算环境因素
   * @param {ee.Geometry} region - 分析区域
   * @param {string} year - 分析年份
   * @return {Object} 包含各环境因素的对象
   */
  computeEnvironmentalFactors: function(region, year) {
    var results = {};
    
    // GST - 生长季平均温度
    results.gst = this.computeGST(year).clip(region);
    
    // GDD - 生长积温
    results.gdd = this.computeGDD(year, 10, 30).clip(region);
    
    // GSP - 生长季降水量
    results.gsp = this.computeGSP(year).clip(region);
    
    // 地形因素
    var dem = ee.Image('USGS/SRTMGL1_003').clip(region);
    results.slope = ee.Terrain.slope(dem);
    results.aspect = ee.Terrain.aspect(dem);
    results.elevation = dem.select('elevation');
    
    // 纬度
    results.latitude = ee.Image.pixelLonLat().select('latitude').clip(region);
    
    return results;
  },
  
  /**
   * 计算生长季平均温度（GST）
   * @param {string} year - 分析年份
   * @return {ee.Image} GST图像
   */
  computeGST: function(year) {
    var tc = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
               .filterDate(year + "-01-01", year + "-12-31")
               .filter(ee.Filter.calendarRange(4, 10, 'month'))
               .map(function(img) {
                 var tmx = img.select("tmmx").divide(10);
                 var tmn = img.select("tmmn").divide(10);
                 return img.addBands(tmx.add(tmn).divide(2).rename("tmean"));
               });
    return tc.select("tmean").mean().rename("GST");
  },
  
  /**
   * 计算生长积温（GDD）
   * @param {string} year - 分析年份
   * @param {number} baseTemp - 基础温度
   * @param {number} daysPerMonth - 每月天数
   * @return {ee.Image} GDD图像
   */
  computeGDD: function(year, baseTemp, daysPerMonth) {
    var tc = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
               .filterDate(year + "-01-01", year + "-12-31")
               .filter(ee.Filter.calendarRange(4, 10, 'month'))
               .select(["tmmx", "tmmn"])
               .map(function(img) {
                 var tmean = img.select("tmmx").divide(10)
                                .add(img.select("tmmn").divide(10))
                                .divide(2);
                 return tmean.subtract(baseTemp).max(0)
                             .multiply(daysPerMonth)
                             .rename("GDD")
                             .copyProperties(img, img.propertyNames());
               });
    return tc.sum().rename("GDD");
  },
  
  /**
   * 计算生长季降水量（GSP）
   * @param {string} year - 分析年份
   * @return {ee.Image} GSP图像
   */
  computeGSP: function(year) {
    var gsp = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
               .filterDate(year + "-01-01", year + "-12-31")
               .filter(ee.Filter.calendarRange(4, 10, 'month'))
               .select("pr")
               .sum()
               .rename("GSP");
    return gsp;
  },
  
  /**
   * 生成环境适宜性掩膜
   * @param {Object} factors - 环境因素对象
   * @return {ee.Image} 环境适宜性掩膜
   */
  computeSuitabilityMask: function(factors) {
    var gstMask = factors.gst.gte(14.0).and(factors.gst.lte(16.0));
    var gddMask = factors.gdd.gte(950).and(factors.gdd.lte(1250));
    var gspMask = factors.gsp.gte(250).and(factors.gsp.lte(600));
    var slopeMask = factors.slope.gte(2).and(factors.slope.lte(15));
    var elevationMask = factors.elevation.gte(5).and(factors.elevation.lte(250));
    
    return gstMask
      .and(gddMask)
      .and(gspMask)
      .and(slopeMask)
      .and(elevationMask);
  },
  
/**
 * 执行机器学习预测
 * @param {Object} factors - 环境因素对象
 * @param {ee.Image} suitabilityMask - 环境适宜性掩膜
 * @param {ee.Geometry} region - 分析区域
 * @param {ee.FeatureCollection} vineyards - 葡萄园数据
 * @return {Object} 机器学习结果对象
 */
runMachineLearning: function(factors, suitabilityMask, region, vineyards) {
  try {
    // 构建特征影像
    var featureImage = ee.Image.cat([
      factors.gst.rename('GST'),
      factors.gdd.rename('GDD'),
      factors.gsp.rename('GSP'),
      factors.slope.rename('slope'),
      factors.aspect.rename('aspect'),
      factors.elevation.rename('elevation'),
      factors.latitude.rename('latitude')
    ]).clip(region);
    
    // 裁剪到分析区域
    var regionalVineyards = vineyards.filterBounds(region);
    
    // 检查是否有足够的葡萄园数据
    var vineyardCount = regionalVineyards.size().getInfo();
    print("区域内葡萄园数量:", vineyardCount);
    
    if (vineyardCount < 5) {
      return {
        success: false,
        error: '所选区域葡萄园数据不足，无法进行机器学习预测',
        suitabilityMask: suitabilityMask // 返回基础适宜性掩膜作为备选结果
      };
    }
    
    // 生成正样本点
    var positivePointCount = Math.min(vineyardCount * 10, 200);
    print("正样本点数量:", positivePointCount);
    
    var positivePoints = ee.FeatureCollection.randomPoints({
      region: regionalVineyards.geometry(),
      points: positivePointCount,
      seed: 123
    }).map(function(feature) {
      return feature.set('class', 1);
    });
    
    // 检查正样本点是否成功生成
    var actualPositiveCount = positivePoints.size().getInfo();
    print("实际生成的正样本点数量:", actualPositiveCount);
    
    if (actualPositiveCount < 5) {
      return {
        success: false,
        error: '无法生成足够的正样本点',
        suitabilityMask: suitabilityMask
      };
    }
    
    // 生成负样本点
    var nonSuitableArea = suitabilityMask.not();
    var negativePoints = ee.FeatureCollection.randomPoints({
      region: region,
      points: 400,
      seed: 456
    }).filter(ee.Filter.bounds(nonSuitableArea.selfMask().geometry()))
      .map(function(feature) {
        return feature.set('class', 0);
      });
    
    // 检查负样本点是否成功生成
    var actualNegativeCount = negativePoints.size().getInfo();
    print("实际生成的负样本点数量:", actualNegativeCount);
    
    if (actualNegativeCount < 5) {
      return {
        success: false,
        error: '无法生成足够的负样本点',
        suitabilityMask: suitabilityMask
      };
    }
    
    // 合并所有样本
    var allPoints = positivePoints.merge(negativePoints);
    
    // 提取特征值
    var sampledPoints = featureImage.sampleRegions({
      collection: allPoints,
      properties: ['class'],
      scale: 100,
      tileScale: 16  // 增加tileScale以处理大区域
    });
    
    // 检查样本点是否成功提取
    var sampleCount = sampledPoints.size().getInfo();
    print("成功提取特征的样本点数量:", sampleCount);
    
    if (sampleCount < 10) {
      return {
        success: false,
        error: '特征提取失败，样本点数量不足',
        suitabilityMask: suitabilityMask
      };
    }
    
    // 划分训练集和测试集
    sampledPoints = sampledPoints.randomColumn();
    var training = sampledPoints.filter(ee.Filter.lt('random', 0.7));
    var testing = sampledPoints.filter(ee.Filter.gte('random', 0.7));
    
    // 检查训练集和测试集
    var trainingCount = training.size().getInfo();
    var testingCount = testing.size().getInfo();
    print("训练集数量:", trainingCount);
    print("测试集数量:", testingCount);
    
    if (trainingCount < 5 || testingCount < 5) {
      return {
        success: false,
        error: '训练集或测试集数量不足',
        suitabilityMask: suitabilityMask
      };
    }
    
    // 训练模型
    var features = ['GST', 'GDD', 'GSP', 'slope', 'aspect', 'elevation', 'latitude'];
    var classifier = ee.Classifier.smileRandomForest({
      numberOfTrees: 50,
      variablesPerSplit: 2,
      seed: 42
    }).train({
      features: training,
      classProperty: 'class',
      inputProperties: features
    });
    
    // 评估模型
    var validation = testing.classify(classifier);
    
    // 创建一个更强大的错误处理方式来计算准确率
    var accuracy;
    try {
      var errorMatrix = validation.errorMatrix('class', 'classification');
      accuracy = errorMatrix.accuracy();
      
      // 获取混淆矩阵的详细信息
      var confMatrix = errorMatrix.array().getInfo();
      print("混淆矩阵:", confMatrix);
      
      // 检查准确率是否是有效数字
      if (isNaN(accuracy.getInfo())) {
        print("警告: 计算的准确率是NaN，使用替代方法计算");
        // 尝试手动计算准确率
        var correct = validation.filter(ee.Filter.eq('class', 'classification')).size();
        var total = validation.size();
        accuracy = ee.Number(correct).divide(total);
      }
    } catch (error) {
      print("计算准确率时出错:", error);
      accuracy = ee.Number(0);  // 设置默认值
    }
    
    // 预测
    var probabilityClassifier = classifier.setOutputMode('PROBABILITY');
    var suitabilityScore = featureImage.classify(probabilityClassifier)
                         .select('classification')
                         .reproject({crs: 'EPSG:4326', scale: 250});
    
    // 高适宜性区域（概率>0.7）
    var highSuitabilityAreas = suitabilityScore.gt(0.7);
    
    // 计算高适宜性区域面积
    var areaCalculation = highSuitabilityAreas.multiply(ee.Image.pixelArea())
                        .reduceRegion({
                          reducer: ee.Reducer.sum(),
                          geometry: region,
                          scale: 250,
                          maxPixels: 1e9
                        });
    
    // 获取特征重要性
    var importance = classifier.explain();
    
    return {
      success: true,
      suitabilityScore: suitabilityScore,
      highSuitabilityAreas: highSuitabilityAreas,
      area: areaCalculation,
      accuracy: accuracy,
      importance: importance,
      featureImage: featureImage,
      classifier: classifier,
      sampledPoints: sampledPoints,  // 返回采样点以便调试
      positiveCount: actualPositiveCount,
      negativeCount: actualNegativeCount
    };
    
  } catch (error) {
    print("机器学习分析过程中出错:", error);
    return {
      success: false,
      error: error.message,
      suitabilityMask: suitabilityMask
    };
  }
},
  
  /**
   * 执行完整的葡萄种植适宜性分析
   * @param {ee.Geometry} region - 分析区域
   * @param {string} year - 分析年份
   * @return {Object} 分析结果对象
   */
  analyzeSuitability: function(region, year) {
    // 加载葡萄园数据
    var vineyards = ee.FeatureCollection("projects/ee-cesong333/assets/existing_vineyards");
    
    // 计算环境因素
    var factors = this.computeEnvironmentalFactors(region, year);
    
    // 计算环境适宜性掩膜
    var suitabilityMask = this.computeSuitabilityMask(factors);
    
    // 执行机器学习预测
    var mlResults = this.runMachineLearning(factors, suitabilityMask, region, vineyards);
    
    return {
      region: region,
      year: year,
      factors: factors,
      suitabilityMask: suitabilityMask,
      mlResults: mlResults,
      vineyards: vineyards
    };
  }
};

// ===== 2. 测试函数 ===
function testGrapeMLAnalysis() {
  // 清除控制台
  print("开始测试葡萄种植适宜性分析功能");
  
  // 加载英国行政区划数据
  var ukLevel2 = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level2")
    .filter(ee.Filter.eq('ADM0_NAME', 'U.K. of Great Britain and Northern Ireland'));
  
  // 定义测试区域 - 肯特郡（英国主要葡萄种植区之一）
  var testRegion = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Kent')).geometry();

  
  // 定义测试年份
  var testYear = '2023';
  
  // 运行分析
  print("分析区域: 肯特郡，年份: " + testYear);
  var results = GrapeML.analyzeSuitability(testRegion, testYear);
  
  // 显示基础环境适宜性
  Map.centerObject(testRegion, 9);
  Map.addLayer(testRegion, {color: 'blue'}, '分析区域');
  Map.addLayer(results.suitabilityMask.selfMask(), {palette: ['green']}, '环境适宜区域');
  Map.addLayer(results.vineyards, {color: 'purple'}, '现有葡萄园');
  
  // 显示机器学习结果（如果成功）
  if (results.mlResults.success) {
    print("机器学习分析成功!");
    Map.addLayer(results.mlResults.suitabilityScore, 
               {min: 0, max: 1, palette: ['white', 'yellow', 'orange', 'red']}, 
               '葡萄种植适宜性概率');
    Map.addLayer(results.mlResults.highSuitabilityAreas.updateMask(results.mlResults.highSuitabilityAreas), 
               {palette: ['#FF00FF']}, 
               '高适宜性区域 (>70%)');
    
    // 打印分析结果
    if (results.mlResults.area && results.mlResults.area.classification) {
      var areaSqKm = results.mlResults.area.classification / 1e6;
      print("高适宜性区域面积: " + areaSqKm.toFixed(2) + " 平方公里");
    }
    
    // 改进显示准确率的代码
    if (results.mlResults.accuracy) {
      try {
        var accuracyValue = results.mlResults.accuracy.getInfo();
        if (!isNaN(accuracyValue)) {
          print("模型准确性: " + (accuracyValue * 100).toFixed(1) + "%");
        } else {
          print("模型准确性: 无法计算（NaN）");
          // 打印更多诊断信息
          print("正样本点数量:", results.mlResults.positiveCount);
          print("负样本点数量:", results.mlResults.negativeCount);
        }
      } catch (error) {
        print("获取准确率时出错:", error);
      }
    } else {
      print("模型准确性: 未计算");
    }
    
    // 打印特征重要性
    if (results.mlResults.importance && 
        results.mlResults.importance.featureNames && 
        results.mlResults.importance.importance) {
      
      print("特征重要性:");
      var featureNames = results.mlResults.importance.featureNames;
      var importanceValues = results.mlResults.importance.importance;
      
      for (var i = 0; i < featureNames.length; i++) {
        print(featureNames[i] + ": " + (importanceValues[i] * 100).toFixed(1) + "%");
      }
    }
    
  } else {
    print("机器学习分析失败: " + results.mlResults.error);
    print("只显示基础环境适宜性区域");
  }
  
  print("测试完成!");
  return results;

}


// ========== START: Unified GEE UI Setup ==========
ui.root.clear();

// === Shared Map Panel ===
var mapPanel = ui.Map();
mapPanel.style().set('stretch', 'both');
mapPanel.setControlVisibility(true);

// === Shared Data ===
var ukLevel2 = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level2")
  .filter(ee.Filter.eq('ADM0_NAME', 'U.K. of Great Britain and Northern Ireland'));

var vineyards = ee.FeatureCollection("projects/ee-cesong333/assets/existing_vineyards");

// === Shared Utility Functions ===
function computeMask(region, year) {
  var factors = GrapeML.computeEnvironmentalFactors(region, year);
  return GrapeML.computeSuitabilityMask(factors).rename('mask').clip(region);
}
function computeArea(mask, region) {
  return mask.multiply(ee.Image.pixelArea())
    .reduceRegion({reducer: ee.Reducer.sum(), geometry: region, scale: 250, maxPixels: 1e10})
    .get('mask');
}

// ====== UI Layout Panels ======
var tabPanel = ui.Panel({layout: ui.Panel.Layout.flow('vertical'), style: {width: '360px', padding: '10px'}});
var moduleButtons = ui.Panel({layout: ui.Panel.Layout.flow('horizontal'), style: {margin: '0 0 10px 0'}});
var moduleContent = ui.Panel({layout: ui.Panel.Layout.flow('vertical'), style: {stretch: 'both'}});
var currentRegion = null;

// ====== Create Module Tab Button ======
function createModuleButton(label, onClickHandler) {
  var button = ui.Button({
    label: label,
    style: {
      margin: '0 4px 0 0',
      backgroundColor: '#f0f0f0',
      padding: '6px 12px',
      border: '1px solid #ccc'
    },
    onClick: function() {
      moduleButtons.widgets().forEach(function(btn) {
        btn.style().set('backgroundColor', '#f0f0f0');
      });
      button.style().set('backgroundColor', '#d6eaff');

      // 🌟 关键：点击前清空 moduleContent
      moduleContent.clear();
      moduleContent.add(onClickHandler());
    }
  });
  return button;
}


// ====== Create Module Panel ======
function createModule1() {
  var panel = ui.Panel({layout: ui.Panel.Layout.flow('vertical'), style: {width: '340px'}});
  var chartPanel = ui.Panel();

  var regionNamesRaw = ee.List(ukLevel2.aggregate_array('ADM2_NAME')).distinct().sort().getInfo();
  var finalRegionNames = [], unsuitableRegions = [];

  regionNamesRaw.forEach(function(name) {
    var geom = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', name)).first().geometry();
    var area = computeArea(computeMask(geom, '2023'), geom).getInfo();
    if (area > 0) {
      finalRegionNames.push(name);
    } else {
      unsuitableRegions.push(geom);
    }
  });
  if (unsuitableRegions.length > 0) {
    finalRegionNames.push('Unsuitable for 10 Consecutive Years (2013–2023)');
  }

  var countySelect = ui.Select({
    items: finalRegionNames,
    value: finalRegionNames[0],
    onChange: updateRegion
  });

  var checkboxSuitability = ui.Checkbox('Show Suitability Mask', true, updateRegion);
  var checkboxVineyards = ui.Checkbox('Show Existing Vineyards (2023)', true, updateRegion);

  var yearSlider = ui.Slider({
    min: 2010, max: 2023, value: 2023, step: 1,
    style: {stretch: 'horizontal', margin: '6px 0'},
    onChange: function(y) {
      if (currentRegion) updateYearlyMap(currentRegion, y);
    }
  });

  var startYearSelect = ui.Select({
    items: ee.List.sequence(2010, 2022).getInfo().map(String),
    value: '2010'
  });
  var endYearSelect = ui.Select({
    items: ee.List.sequence(2011, 2023).getInfo().map(String),
    value: '2023'
  });

  var persistentButton = ui.Button({
    label: 'Show Area Suitable Every Year',
    onClick: function() {
      if (currentRegion) {
        var s = parseInt(startYearSelect.getValue());
        var e = parseInt(endYearSelect.getValue());
        showPersistentSuitability(currentRegion, s, e);
      }
    }
  });

  panel.add(ui.Label('1. Select County', {fontWeight: 'bold'}));
  panel.add(countySelect);
  panel.add(ui.Label('2. Suitable Area (km²) 2010–2023', {fontWeight: 'bold'}));
  panel.add(chartPanel);
  panel.add(ui.Label('3. View Suitability for a Specific Year', {fontWeight: 'bold'}));
  panel.add(yearSlider);
  panel.add(ui.Label('4. View Persistently Suitable Area (Multi-Year)', {fontWeight: 'bold'}));
  panel.add(ui.Panel([
    ui.Label('From:'), startYearSelect,
    ui.Label('To:'), endYearSelect,
    persistentButton
  ], ui.Panel.Layout.flow('horizontal')));
  panel.add(ui.Label('5. Toggle Layers', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(checkboxSuitability);
  panel.add(checkboxVineyards);

  function updateRegion() {
    chartPanel.clear();
    mapPanel.layers().reset();
    yearSlider.setValue(2023);

    var name = countySelect.getValue();
    currentRegion = (name === 'Unsuitable for 10 Consecutive Years (2013–2023)') ?
      ee.FeatureCollection(unsuitableRegions).union().geometry() :
      ukLevel2.filter(ee.Filter.eq('ADM2_NAME', name)).first().geometry();

    mapPanel.centerObject(currentRegion, 8);
    mapPanel.addLayer(currentRegion, {color: 'blue'}, 'Boundary');

    var years = ee.List.sequence(2010, 2023).getInfo();
    var features = years.map(function(y) {
      var mask = computeMask(currentRegion, String(y));
      var area = computeArea(mask, currentRegion);
      return ee.Feature(null, {year: y, area_km2: ee.Number(area).divide(1e6)});
    });
    var ts = ee.FeatureCollection(features);

    var chart = ui.Chart.feature.byFeature(ts, 'year', 'area_km2')
      .setChartType('LineChart')
      .setOptions({
        hAxis: {title: 'Year'},
        vAxis: {title: 'Area (km²)'},
        lineWidth: 2, pointSize: 5, series: {0: {color: '#228B22'}}, height: 220
      });
    chartPanel.add(chart);

    if (checkboxSuitability.getValue()) {
      var m = computeMask(currentRegion, '2023');
      mapPanel.addLayer(m.selfMask(), {palette: ['#00FF00'], opacity: 0.7}, 'Suitability 2023');
    }
    if (checkboxVineyards.getValue()) {
      mapPanel.addLayer(vineyards.filterBounds(currentRegion), {color: 'purple'}, 'Existing Vineyards (2023)');
    }
  }

  function updateYearlyMap(region, year) {
    mapPanel.layers().reset();
    mapPanel.addLayer(region, {color: 'blue'}, 'Boundary');
    var mask = computeMask(region, String(year));
    mapPanel.addLayer(mask.selfMask(), {palette: ['#228B22'], opacity: 0.7}, 'Suitability ' + year);
    if (checkboxVineyards.getValue()) {
      mapPanel.addLayer(vineyards.filterBounds(region), {color: 'purple'}, 'Existing Vineyards (2023)');
    }
  }

  function showPersistentSuitability(region, startYear, endYear) {
    mapPanel.layers().reset();
    mapPanel.addLayer(region, {color: 'blue'}, 'Boundary');

    var maskImages = [];
    for (var y = startYear; y <= endYear; y++) {
      maskImages.push(computeMask(region, String(y)));
    }
    var allYears = ee.ImageCollection(maskImages).reduce(ee.Reducer.allNonZero());
    mapPanel.addLayer(allYears.selfMask(), {palette: ['#006400'], opacity: 0.8},
                      'Persistent Suitability ' + startYear + '–' + endYear);

    if (checkboxVineyards.getValue()) {
      mapPanel.addLayer(vineyards.filterBounds(region), {color: 'purple'}, 'Existing Vineyards (2023)');
    }
    yearSlider.setValue(2023);
  }

  updateRegion();
  return panel;
}

// ========== Module 2: Custom Regional Analysis ==========

function createModule2() {
  var panel = ui.Panel({layout: ui.Panel.Layout.flow('vertical'), style: {width: '340px'}});

  var chartPanel = ui.Panel();
  var infoPanel = ui.Panel();
  var savedGeometries = [];
  var savedLayers = [];

  panel.add(ui.Label('Module 2: Custom Regional Analysis', {fontSize: '18px', fontWeight: 'bold', margin: '0 0 8px'}));

  panel.add(ui.Label('1. Area Trend (ML & Existing)', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(chartPanel);

  panel.add(ui.Label('2. Area Statistics', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(infoPanel);

  // ====== Drawing Tools 设置 ======
  var drawingTools = mapPanel.drawingTools();
  drawingTools.setLinked(false);
  drawingTools.setDrawModes(['rectangle', 'polygon']);
  drawingTools.setShown(true);

  // ====== 删除指定图层工具函数 ======
  function removeNamedLayers(layerNames) {
    mapPanel.layers().forEach(function(layer) {
      var name = layer.getName();
      if (layerNames.indexOf(name) !== -1) {
        mapPanel.remove(layer);
      }
    });
  }

  // ====== 保存绘制区域 ======
  var saveButton = ui.Button('Save', function() {
    var drawn = drawingTools.layers().get(0);
    if (!drawn) {
      print('Please draw a region first.');
      return;
    }
    var geom = drawn.toGeometry();
    savedGeometries.push(geom);
    var layer = mapPanel.addLayer(geom, {color: 'blue'}, 'Saved Region ' + savedGeometries.length);
    savedLayers.push(layer);
    drawingTools.layers().reset();
  });

  // ====== 清除绘制或保存的区域 ======
  var clearButton = ui.Button('Clear', function() {
    if (drawingTools.layers().length() > 0) {
      drawingTools.layers().reset();
    } else if (savedLayers.length > 0) {
      mapPanel.remove(savedLayers.pop());
      savedGeometries.pop();
    }
    chartPanel.clear();
    infoPanel.clear();
    removeNamedLayers(['ML Suitability', 'Existing Vineyards']);
  });

  // ====== 计算并展示区域统计信息 ======
  function computeAndDisplayStats(region, yearList) {
    var featureList = yearList.map(function(y) {
      var mask = computeMask(region, String(y));
      var suitable = ee.Number(computeArea(mask, region)).divide(1e6); // ✅ 注意这里包上 ee.Number()
      var vineyardsInRegion = vineyards.filterBounds(region);
      var vineyardArea = ee.Image.pixelArea().clip(region).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: vineyardsInRegion.geometry(),
        scale: 250,
        maxPixels: 1e10
      }).getNumber('area');

      return ee.Feature(null, {
        year: y,
        suitable_km2: suitable,
        vineyard_km2: ee.Number(vineyardArea).divide(1e6)
      });
    });

    var trend = ee.FeatureCollection(featureList);

    chartPanel.clear();
    var chart = ui.Chart.feature.byFeature(trend, 'year', ['suitable_km2', 'vineyard_km2'])
      .setChartType('LineChart')
      .setOptions({
        title: 'ML Suitability vs Existing Vineyards (2015–2023)',
        hAxis: {title: 'Year'},
        vAxis: {title: 'Area (km²)'},
        lineWidth: 2,
        pointSize: 4,
        height: 300
      });
    chartPanel.add(chart);

    trend.sort('year', false).first().evaluate(function(f) {
      infoPanel.clear();
      if (f && f.properties) {
        infoPanel.add(ui.Label('Suitable Area (ML): ' + f.properties.suitable_km2.toFixed(2) + ' km²'));
        infoPanel.add(ui.Label('Existing Vineyards Area: ' + f.properties.vineyard_km2.toFixed(2) + ' km²'));
        infoPanel.add(ui.Label('Plantable Area: ' + (f.properties.suitable_km2 - f.properties.vineyard_km2).toFixed(2) + ' km²'));
      } else {
        infoPanel.add(ui.Label('No Data Available.'));
      }
    });
  }

  // ====== 运行 ML 预测按钮 ======
  var runButton = ui.Button('Run ML Prediction', function() {
    var drawn = drawingTools.layers().get(0);
    if (!drawn) {
      print('Please draw a region first.');
      return;
    }
    var geometry = drawn.toGeometry();
    var result = GrapeML.analyzeSuitability(geometry, '2023');

    if (result.mlResults.success) {
      mapPanel.addLayer(result.mlResults.highSuitabilityAreas.selfMask(), {palette: ['#FF00FF'], opacity: 0.5}, 'ML Suitability');
      mapPanel.addLayer(result.vineyards.filterBounds(geometry), {color: 'purple'}, 'Existing Vineyards');
      computeAndDisplayStats(geometry, [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023]);
    } else {
      infoPanel.clear();
      infoPanel.add(ui.Label('Prediction failed: ' + result.mlResults.error));
    }
  });

  // ====== 控制按钮布局 ======
  panel.add(ui.Label('3. Actions', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(ui.Panel([saveButton, clearButton], ui.Panel.Layout.flow('horizontal')));
  panel.add(runButton);
  panel.add(ui.Label('Note: Click "Run ML Prediction" after drawing region.', {color: 'gray', margin: '4px 0 0'}));

  return panel;
}


// ========== Module 3: Regional Comparison ==========

function createModule3() {
  var panel = ui.Panel({layout: ui.Panel.Layout.flow('vertical'), style: {width: '340px'}});
  
  var compareChartPanel = ui.Panel();
  var compareInfoPanel = ui.Panel();
  var savedCompareGeometries = [];

  panel.add(ui.Label('Module 3: Regional Comparison', {fontSize: '18px', fontWeight: 'bold', margin: '0 0 8px'}));

  panel.add(ui.Label('1. Area Trend (ML & Existing)', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(compareChartPanel);

  panel.add(ui.Label('2. Area Statistics', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(compareInfoPanel);

  var drawingTools = mapPanel.drawingTools();
  drawingTools.setLinked(false);
  drawingTools.setDrawModes(['rectangle', 'polygon']);
  drawingTools.setShown(true);

  function computeTrend(region) {
  var years = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
  return ee.FeatureCollection(years.map(function(y) {
    var mask = computeMask(region, String(y));
    var areaDict = mask.multiply(ee.Image.pixelArea())
      .reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: region,
        scale: 250,
        maxPixels: 1e10
      });
    var suitable = ee.Number(areaDict.get('mask')).divide(1e6);  // 取出面积并转为 km²

    var vineyardArea = ee.Image.pixelArea().clip(region).reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: vineyards.filterBounds(region).geometry(),
      scale: 250,
      maxPixels: 1e10
    }).getNumber('area');

    return ee.Feature(null, {
      year: y,
      suitable_km2: suitable,
      vineyard_km2: ee.Number(vineyardArea).divide(1e6)
    });
  }));
}


  function createChart(title, trend) {
    return ui.Chart.feature.byFeature(trend, 'year', ['suitable_km2', 'vineyard_km2'])
      .setChartType('LineChart')
      .setOptions({
        title: title,
        hAxis: {title: 'Year'},
        vAxis: {title: 'Area (km²)'},
        series: {
          0: {color: 'green'},
          1: {color: 'purple'}
        },
        lineWidth: 2,
        pointSize: 4,
        width: 350,
        height: 250
      });
  }

  var saveButton = ui.Button('Save', function() {
    var drawn = drawingTools.layers().get(0);
    if (!drawn) {
      print('Please draw a region first.');
      return;
    }
    var geom = drawn.toGeometry();
    savedCompareGeometries.push(geom);
    mapPanel.addLayer(geom, {color: 'blue'}, 'Compare Region ' + savedCompareGeometries.length);
    drawingTools.layers().reset();
  });

  var clearButton = ui.Button('Clear', function() {
    if (drawingTools.layers().length() > 0) {
      drawingTools.layers().reset();
    } else if (savedCompareGeometries.length > 0) {
      savedCompareGeometries.pop();
      mapPanel.layers().remove(mapPanel.layers().length() - 1);
    }
    compareChartPanel.clear();
    compareInfoPanel.clear();
  });

  var compareButton = ui.Button('Compare', function() {
    compareChartPanel.clear();
    compareInfoPanel.clear();

    if (savedCompareGeometries.length < 2) {
      print('Please save two regions to compare.');
      return;
    }

    var regionA = savedCompareGeometries[savedCompareGeometries.length - 2];
    var regionB = savedCompareGeometries[savedCompareGeometries.length - 1];

    var trendA = computeTrend(regionA);
    var trendB = computeTrend(regionB);

    // 绘制趋势图
    var trendRow = ui.Panel({layout: ui.Panel.Layout.flow('horizontal'), style: {stretch: 'both'}});
    trendRow.add(createChart('Region A', trendA));
    trendRow.add(createChart('Region B', trendB));
    compareChartPanel.add(trendRow);

    // 绘制统计信息
    trendA.sort('year', false).first().evaluate(function(featA) {
      var propsA = featA.properties;
      var boxA = ui.Panel({style: {border: '1px solid gray', padding: '6px', width: '180px'}});
      boxA.add(ui.Label('Region A', {fontWeight: 'bold', margin: '4px 0'}));
      boxA.add(ui.Label('Suitable: ' + propsA.suitable_km2.toFixed(2) + ' km²'));
      boxA.add(ui.Label('Vineyards: ' + propsA.vineyard_km2.toFixed(2) + ' km²'));
      boxA.add(ui.Label('Plantable: ' + (propsA.suitable_km2 - propsA.vineyard_km2).toFixed(2) + ' km²'));

      trendB.sort('year', false).first().evaluate(function(featB) {
        var propsB = featB.properties;
        var boxB = ui.Panel({style: {border: '1px solid gray', padding: '6px', width: '180px'}});
        boxB.add(ui.Label('Region B', {fontWeight: 'bold', margin: '4px 0'}));
        boxB.add(ui.Label('Suitable: ' + propsB.suitable_km2.toFixed(2) + ' km²'));
        boxB.add(ui.Label('Vineyards: ' + propsB.vineyard_km2.toFixed(2) + ' km²'));
        boxB.add(ui.Label('Plantable: ' + (propsB.suitable_km2 - propsB.vineyard_km2).toFixed(2) + ' km²'));

        var statsRow = ui.Panel({layout: ui.Panel.Layout.flow('horizontal'), style: {stretch: 'horizontal', margin: '6px 0'}});
        statsRow.add(boxA);
        statsRow.add(boxB);
        compareInfoPanel.add(statsRow);
      });
    });
  });

  // 加按钮
  panel.add(ui.Label('3. Actions', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(ui.Panel([saveButton, clearButton, compareButton], ui.Panel.Layout.flow('horizontal')));

  return panel;
}


// ====== Add Module Buttons ======
var button1 = createModuleButton('Module 1: County Analysis', createModule1);
var button2 = createModuleButton('Module 2: Custom Analysis', createModule2);
var button3 = createModuleButton('Module 3: Regional Comparison', createModule3);

moduleButtons.add(button1);
moduleButtons.add(button2);
moduleButtons.add(button3);

tabPanel.add(moduleButtons);
tabPanel.add(moduleContent);

ui.root.add(ui.SplitPanel(tabPanel, mapPanel));

// ====== Load default ======
button1.style().set('backgroundColor', '#d6eaff');
moduleContent.add(createModule1());
