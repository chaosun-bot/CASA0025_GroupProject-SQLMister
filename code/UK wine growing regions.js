/*************************************************
 * 数据预处理 – 基于 GST 参数筛选
 * 目标：仅依据生长季（4–10月）平均气温（GST）来生成适宜性掩膜，
 *       筛选条件：14.1°C ≤ GST ≤ 15.5°C
 *
 * 数据来源：
 *   - TerraClimate: IDAHO_EPSCOR/TERRACLIMATE
 *     2024 年数据中，主要波段为 tmmx（最高温）和 tmmn（最低温），数值放大10倍
 *   - 英国边界：USDOS/LSIB_SIMPLE/2017
 *************************************************/

/***** 1. 定义英国边界 (ROI) *****/
var countries = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017");
var UK_boundary = countries.filter(ee.Filter.eq("country_na", "United Kingdom"));
print("UK Boundary:", UK_boundary);
Map.centerObject(UK_boundary, 6);
Map.addLayer(UK_boundary, {color: 'red', width: 2}, "UK Boundary (Raw)");

/***** 2. 导入 TerraClimate 数据 *****/
// 使用 TerraClimate 2024 年数据（如有数据，否则请调整年份）
var terraclimate = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
                    .filterBounds(UK_boundary)
                    .filterDate("2024-01-01", "2024-12-31");

/***** 3. 筛选生长季 (4–10月) 数据 *****/
// 选取生长季数据，并选择 tmmx 和 tmmn 波段
var growingSeason = terraclimate.filter(ee.Filter.calendarRange(4, 10, 'month'))
                                .select(["tmmx", "tmmn"]);
print("Growing Season Collection:", growingSeason.limit(5));

/***** 4. 计算每月 tmean *****/
// tmean = (tmmx + tmmn) / 2，其中 tmmx 和 tmmn 除以 10 得到真实温度 (°C)
var withTmean = growingSeason.map(function(img) {
  var tmaxC = img.select("tmmx").divide(10);
  var tminC = img.select("tmmn").divide(10);
  var tmean = tmaxC.add(tminC).divide(2).rename("tmean");
  return img.addBands(tmean);
});
print("Monthly tmean sample:", withTmean.limit(5));

/***** 5. 计算生长季平均气温 GST *****/
// 对生长季 (4–10月) 所有 tmean 影像取平均
var GST = withTmean.select("tmean").mean().clip(UK_boundary).rename("GST");
print("GST Image:", GST);
Map.addLayer(GST, {min: 10, max: 20, palette: ['blue', 'green', 'yellow', 'red']}, "GST (°C)");

/***** 6. 根据 GST 参数筛选适宜区域 *****/
// 适宜性条件：GST 在 14.1°C 到 15.5°C 之间
var gstMask = GST.gte(14.1).and(GST.lte(15.5));
print("GST Suitability Mask:", gstMask);

// 将 mask 应用后仅显示满足条件的区域
Map.addLayer(gstMask.updateMask(gstMask), {palette: ['green']}, "GST Suitability Mask");

/*************************************************
 * 计算 GDD: Growing Degree Days (生长积温)
 * 前提：已获得生长季（4–10月）的月均温 tmean (单位 °C)
 * 计算方法：
 *   GDD_month = max(0, tmean - baseTemp) * days_in_month
 *   假设每个月固定为30天，基温取10°C（可根据需要调整）
 *************************************************/

// 设定基温
var baseTemp = 10;

// 在之前步骤中，我们已经得到了 withTmean 这个 ImageCollection，其中包含每个月份生长季的 tmean 波段。
// 示例：如果你还没有计算，可以参考下列代码片段（假设使用 TerraClimate 的 tmmx/tmmn 并除以10得到 tmean）：
/*
var growingSeason = terraclimate.filter(ee.Filter.calendarRange(4, 10, 'month'))
                                .select(["tmmx", "tmmn"]);
var withTmean = growingSeason.map(function(img) {
  var tmaxC = img.select("tmmx").divide(10);
  var tminC = img.select("tmmn").divide(10);
  var tmean = tmaxC.add(tminC).divide(2).rename("tmean");
  return img.addBands(tmean);
});
*/

// 现在计算每个月的 GDD：GDD_month = max(0, tmean - baseTemp) * 30
var monthlyGDD = withTmean.map(function(img) {
  var tmean = img.select("tmean");
  var gdd = tmean.subtract(baseTemp).max(0).multiply(30).rename("gdd");
  return gdd.copyProperties(img, img.propertyNames());
});

// 累加所有生长季月份的 GDD, 得到整个生长季的总生长积温
var GDD = monthlyGDD.sum().clip(UK_boundary).rename("GDD");

// 将 GDD 影像添加到地图上进行可视化（根据实际数据调节 min/max 参数）
Map.addLayer(GDD, {min: 500, max: 1500, palette: ['white', 'red']}, "GDD (°C-days)");

// 打印 GDD 统计信息以供调试
var gddStats = GDD.reduceRegion({
  reducer: ee.Reducer.minMax().combine({
    reducer2: ee.Reducer.mean(),
    sharedInputs: true
  }),
  geometry: UK_boundary,
  scale: 4000,
  maxPixels: 1e9
});
print("GDD Statistics:", gddStats);

/***** 根据 GDD 参数筛选适宜区域 *****/
// 适宜性条件：GDD 在 974 到 1223 °C·days 之间
var gddMask = GDD.gte(974).and(GDD.lte(1223));
print("GDD Suitability Mask (binary):", gddMask);

// 将掩膜应用到地图上：仅显示满足条件的区域，设定调色板为绿色
Map.addLayer(gddMask.updateMask(gddMask), {palette: ['green']}, "GDD Suitability Mask");

/***** 计算 GSP: 生长季降水量 (4–10月) *****/
// 采用 TerraClimate 数据中的 'pr' 波段，单位为 mm
// 此处假设你已经完成前面的数据导入和 ROI (UK_boundary) 的设置

// 筛选生长季（4–10月）的 TerraClimate 数据，并选择 'pr' 波段
var growingSeasonGSP = terraclimate.filter(ee.Filter.calendarRange(4, 10, 'month'))
                                .select("pr");

// 对生长季数据进行累加（求和），得到降水量（GSP），并裁剪至英国区域
var GSP = growingSeasonGSP.sum().clip(UK_boundary).rename("GSP");

// 添加图层进行可视化，参考可视化参数可根据实际数据调整
Map.addLayer(GSP, {min: 200, max: 700, palette: ['white', 'blue']}, "GSP (mm)");
print("GSP Image:", GSP);

/***** 根据 GSP 数值范围筛选适宜区域 *****/
// 适宜性条件：GSP >= 273 mm 且 GSP <= 449 mm
var gspMask = GSP.gte(273).and(GSP.lte(449));
print("GSP Suitability Mask (binary):", gspMask);

// 使用更新掩膜 (updateMask) 只显示满足条件的区域，并用蓝色调色板显示
Map.addLayer(gspMask.updateMask(gspMask), {palette: ['blue']}, "GSP Suitability Mask");

/*************************************************
 * 计算 FlavorHours：风味酶活性温度区间小时数
 *   时间段：2024-07-20 至 2024-09-20
 *   条件：温度在 16–22°C（ERA5-Land 的 temperature_2m 波段，单位 K）
 * 输出：FlavorHours（累计小时数）
 *************************************************/

// 1. 定义英国边界 ROI
var countries = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017");
var UK_boundary = countries.filter(ee.Filter.eq("country_na", "United Kingdom"));
Map.centerObject(UK_boundary, 6);

// 2. 导入并过滤 ERA5-Land Hourly 数据（2024年）
var era5 = ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY")
            .filterBounds(UK_boundary)
            .filterDate("2024-07-20", "2024-09-20")
            .select("temperature_2m");  // 单位：K

// 3. 将温度从 K 转换为 °C
var era5C = era5.map(function(img) {
  return img
    .subtract(273.15)         // K -> °C
    .rename("tempC")
    .copyProperties(img, img.propertyNames());
});

// 4. 生成二值图像：如果 16°C <= tempC <= 22°C 则为1，否则为0
var flags = era5C.map(function(img) {
  return img
    .gte(16).and(img.lte(22)) // inRange
    .rename("flavorFlag")
    .copyProperties(img, img.propertyNames());
});

// 5. 累加所有小时的 flag，得到累计小时数
var FlavorHours = flags
  .sum()                     // 将一天中所有小时的 0/1 累加
  .clip(UK_boundary)
  .rename("FlavorHours");

// 6. 可视化并打印
Map.addLayer(FlavorHours, {min: 0, max: 1000, palette: ['white','orange']}, "FlavorHours");
print("FlavorHours Image:", FlavorHours);

// （可选）查看区域统计信息
var stats = FlavorHours.reduceRegion({
  reducer: ee.Reducer.minMax().combine({
    reducer2: ee.Reducer.mean(),
    sharedInputs: true
  }).combine({
    reducer2: ee.Reducer.stdDev(),
    sharedInputs: true
  }),
  geometry: UK_boundary,
  scale: 10000,
  maxPixels: 1e9
});
print("FlavorHours stats:", stats);

/***** 基于 FlavorHours 阈值筛选适宜区域 *****/
// 设定阈值，例如 800 小时
var threshold = 800;

// 构建二值掩膜：FlavorHours 在 [threshold, +∞)
var flavorMask = FlavorHours.gte(threshold);
print("FlavorHours Suitability Mask:", flavorMask);

// 将掩膜应用并渲染，仅显示满足条件的区域
Map.addLayer(flavorMask.updateMask(flavorMask), {palette: ['orange']}, 
             "FlavorHours ≥ " + threshold + "h");

/***** 1. 加载并可视化全英国的土壤 pH 值 *****/

// 1.1 定义 UK 边界
var countries = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017");
var UK_boundary = countries
  .filter(ee.Filter.eq('country_na', 'United Kingdom'));

// 1.2 加载 OpenLandMap 土壤 pH（H2O）数据
// band b0 单位为 0.1 pH，除以 10 得到真实 pH
var soilPH = ee.Image("OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02")
  .select('b0')
  .divide(10)
  .rename('soilPH')
  .clip(UK_boundary);

// 1.3 可视化参数：用渐变色显示 pH 4.0–8.0
var visContinuous = {
  min: 4.0,
  max: 8.0,
  palette: [
    '#d7191c', // 酸性（pH≈4）
    '#fdae61', // pH≈5
    '#ffffbf', // pH≈6
    '#abdda4', // pH≈7
    '#2b83ba'  // 碱性（pH≈8）
  ]
};

// 1.4 添加图层
Map.setCenter(-1.5, 52.0, 6);
Map.addLayer(soilPH, visContinuous, 'Soil pH (4–8 Gradient)');

/***** 2. 筛选并可视化 pH 在 6.8–7.2 之间的区域 *****/

// 2.1 基于 soilPH 图像，生成符合条件的掩膜影像
var phMask = soilPH
  .gte(6.8)        // pH ≥ 6.8
  .and(soilPH.lte(7.2)); // pH ≤ 7.2

// 2.2 将掩膜应用到原始影像上
var soilPH_6_8_7_2 = soilPH.updateMask(phMask);

// 2.3 可视化：只显示 pH 6.8–7.2 的区域，用单色高亮
var visMask = {
  palette: ['00FF00'],  // 绿色表示 6.8–7.2 区间
  min: 6.8,
  max: 7.2
};

// 2.4 添加图层
Map.addLayer(soilPH_6_8_7_2, visMask, 'pH 6.8–7.2 Areas');

// =====================================================
// 英国葡萄种植适宜性分析（2024年）
// 数据处理与分析内容：
// - 利用 2024 年 LANDSAT 8 遥感数据计算 NDVI、NDWI、NDMI 指数
// - 基于 SRTM 数据提取坡度（0–10°）与高程（50–220m）信息
// - 利用 ERA5-Land 气候数据计算全年太阳辐射总量（≥ 2700 MJ/m²）
// - 利用土地覆盖数据筛选适宜葡萄种植的土地类型
// - 叠加葡萄园现有分布，实现适宜性空间分析可视化
// =====================================================


// ===================== 模块 1：设置分析范围与时间 =====================
var startDate = ee.Date('2024-01-01');
var endDate = ee.Date('2024-12-31');

var countries = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017");
var UK_boundary = countries.filter(ee.Filter.eq("country_na", "United Kingdom"));

// ===================== 模块 2：加载现有葡萄园矢量数据 =====================
var existing_vineyards = ee.FeatureCollection("projects/ee-cesong333/assets/existing_vineyards");
Map.addLayer(existing_vineyards, {color: 'purple'}, '现有葡萄园');


// ===================== PART 1：植被水分指数分析 =====================
// 加载并处理 LANDSAT 8 数据
var l8 = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
  .filterBounds(UK_boundary)
  .filterDate(startDate, endDate)
  .filter(ee.Filter.lt('CLOUD_COVER', 60))
  .map(function(image) {
    var sr = image.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'])
                  .multiply(0.0000275).add(-0.2);
    
    var ndvi = sr.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');  // 植被指数
    var ndwi = sr.normalizedDifference(['SR_B3', 'SR_B5']).rename('NDWI');  // 水分指数
    var ndmi = sr.normalizedDifference(['SR_B5', 'SR_B6']).rename('NDMI');  // 水分胁迫指数

    return image.addBands([ndvi, ndwi, ndmi]);
  });

// 获取中位数影像并裁剪英国区域
var median = l8.median().clip(UK_boundary);

// 创建掩膜
var ndvi_mask = median.select('NDVI').gt(0.2);
var ndwi_mask = median.select('NDWI').lt(0.3);
var ndmi_mask = median.select('NDMI').gt(0.2);

// 可视化掩膜图层
Map.addLayer(ndvi_mask.updateMask(ndvi_mask), {palette: ['00FF00']}, 'NDVI > 0.2');
Map.addLayer(ndwi_mask.updateMask(ndwi_mask), {palette: ['0000FF']}, 'NDWI < 0.3');
Map.addLayer(ndmi_mask.updateMask(ndmi_mask), {palette: ['FFA500']}, 'NDMI > 0.2');


// ===================== PART 2：坡度分析（0–10°） =====================
var dem = ee.Image('USGS/SRTMGL1_003');
var slope = ee.Terrain.slope(dem);

// 可视化坡度在 0–10 度之间的区域
var slopeVis = {
  min: 0,
  max: 10,
  palette: ['lightblue', 'green', 'darkgreen']
};

Map.centerObject(UK_boundary, 6);
Map.addLayer(slope.clip(UK_boundary), slopeVis, '坡度 Slope (0–10°)');


// ===================== PART 3：高程分析（50–220 米） =====================
var elevation = dem.select('elevation');
var elevationMask = elevation.gte(50).and(elevation.lte(220));
var elevationFiltered = elevation.updateMask(elevationMask);

var elevationVis = {
  min: 50,
  max: 220,
  palette: ['lightblue', 'yellow', 'green']
};

Map.addLayer(elevationFiltered.clip(UK_boundary), elevationVis, '高程 Elevation (50–220m)');


// ===================== PART 4：太阳辐射分析（≥ 2700 MJ/m²） =====================
var era5 = ee.ImageCollection('ECMWF/ERA5_LAND/MONTHLY_AGGR')
              .filterDate(startDate, endDate)
              .select('surface_net_solar_radiation_sum');

var annualRadiation = era5.sum().divide(1e6);  // J → MJ
var radiationMask = annualRadiation.gte(2700);
var radiationFiltered = annualRadiation.updateMask(radiationMask);

var radiationVis = {
  min: 2700,
  max: 6000,
  palette: ['white', 'yellow', 'orange', 'red']
};

Map.addLayer(radiationFiltered.clip(UK_boundary), radiationVis, '年太阳辐射 ≥ 2700 MJ/m²');


// ===================== PART 5：土地利用适宜性分析 =====================
var landcover = ee.Image('projects/ee-cesong333/assets/Land_Cover_Map_10m');

// 可视化原始土地覆盖图
Map.addLayer(landcover.clip(UK_boundary), {}, '原始地类 Raw Land Cover');

// 定义适宜种植葡萄的地类编码（需根据图例确认）
var suitableCodes = [1, 2, 3, 4, 5, 6, 7, 10, 12];

var suitableMask = landcover.remap(
  suitableCodes,
  ee.List.repeat(1, suitableCodes.length)
);

var suitableLand = landcover.updateMask(suitableMask);

// 可视化适宜种植区域
Map.addLayer(suitableMask.updateMask(suitableMask), 
  {palette: ['green']}, 
  '适宜种植葡萄的土地 Suitable Land');
