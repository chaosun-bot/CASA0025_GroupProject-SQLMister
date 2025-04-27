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
var UK = getUKBoundary();
Map.centerObject(UK, 6);
Map.addLayer(UK, {color: 'red', width: 2}, "UK Boundary");

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



  // --------------------- Step 2:  --------------------------------