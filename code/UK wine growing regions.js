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
