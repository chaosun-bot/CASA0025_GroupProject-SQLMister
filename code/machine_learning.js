
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

  // 初始设置为英格兰东南部
  var analysisRegion = regions['肯特郡'];
  
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

// =========== Part 1: 全局变量声明 ===========
var mapPanel = null;
var controlPanel = null;
var countyInput = null;
var yearSlider = null;
var startYearInput = null;
var endYearInput = null;
var checkboxSuitability = null;
var checkboxVineyards = null;
var checkboxRegion = null;
var chartPanel = null;
var yearInputPanel = null;
var currentRegion = null;
var currentCountyName = 'Kent';
var modeSelect = 'Single Year';
var loadingLabel = null;
var backgroundLoadingInProgress = false;
var bgLoadingLabel = null;

// 加载行政区数据 - 在全局范围预加载
var ukLevel2 = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level2")
  .filter(ee.Filter.eq('ADM0_NAME', 'U.K. of Great Britain and Northern Ireland'));

// 加载葡萄园数据 - 在全局范围预加载
var vineyards = ee.FeatureCollection("projects/ee-cesong333/assets/existing_vineyards");

// 定义全局变量存储功能页面状态
var currentPage = "home";

// =========== Part 2: 功能函数 ===========

// 定义 computeMask
function computeMask(region, year) {
  // 计算掩膜
  var factors = GrapeML.computeEnvironmentalFactors(region, year);
  var mask = GrapeML.computeSuitabilityMask(factors).rename('mask').clip(region);
  return mask;
}

// 显示加载状态
function showLoading(message) {
  if (loadingLabel) {
    loadingLabel.setValue(message);
    return;
  }
  
  loadingLabel = ui.Label({
    value: message,
    style: {
      backgroundColor: '#f9edbe',
      color: '#494949',
      padding: '8px',
      margin: '4px 0',
      textAlign: 'center',
      fontSize: '14px'
    }
  });
  
  if (controlPanel) {
    controlPanel.insert(0, loadingLabel);
  }
}

// 显示后台加载进度
function showBackgroundLoading(message) {
  // 如果已经有主加载指示器，不显示后台加载
  if (loadingLabel) return;
  
  if (bgLoadingLabel) {
    bgLoadingLabel.setValue(message);
  } else {
    bgLoadingLabel = ui.Label({
      value: message,
      style: {
        color: '#666666',
        fontSize: '12px',
        textAlign: 'right',
        padding: '4px'
      }
    });
    controlPanel.insert(1, bgLoadingLabel);
  }
}

// 隐藏后台加载状态
function hideBackgroundLoading() {
  if (bgLoadingLabel && controlPanel) {
    controlPanel.remove(bgLoadingLabel);
    bgLoadingLabel = null;
  }
}

// 隐藏加载状态
function hideLoading() {
  if (loadingLabel && controlPanel) {
    controlPanel.remove(loadingLabel);
    loadingLabel = null;
  }
}

// 工具函数 
function computeArea(mask, region) {
  // 计算面积
  var area = mask.multiply(ee.Image.pixelArea())
    .reduceRegion({
      reducer: ee.Reducer.sum(), 
      geometry: region, 
      scale: 250, 
      maxPixels: 1e10
    })
    .get('mask');
    
  return area;
}

function getRegionGeometry(name) {
  var geom;
  if (name === 'Unsuitable for 3 Years') {
    geom = ee.FeatureCollection(unsuitableGeomsList.map(function(g) {
      return ee.Feature(g);
    })).union().first().geometry();
  } else {
    geom = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', name)).first().geometry();
  }
  
  return geom;
}

// 创建图例行的辅助函数
function createLegendRow(color, label) {
  var row = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%', margin: '4px 0', padding: '4px'}
  });

  var colorBox = ui.Label('', {
    backgroundColor: color,
    padding: '8px',
    margin: '0 8px 0 0'
  });

  var labelText = ui.Label(label, {margin: '4px 0 0 0'});

  row.add(colorBox);
  row.add(labelText);

  return row;
}

// =========== Part 3: 主页面 ===========

// 创建主页面
function createHomePage() {
  ui.root.clear();
  currentPage = "home";
  
  // 创建一个面板来容纳所有内容
  var mainPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '600px',
      maxWidth: '800px',
      height: '100%',
      padding: '20px',
      margin: 'auto',
      backgroundColor: 'white'
    }
  });
  
  // 添加标题
  var titleLabel = ui.Label('葡萄种植分析工具集', {
    fontWeight: 'bold',
    fontSize: '24px',
    margin: '10px 0 20px 0',
    textAlign: 'center'
  });
  mainPanel.add(titleLabel);
  
  // 添加副标题
  var subtitleLabel = ui.Label('请选择您要使用的功能:', {
    fontSize: '16px',
    margin: '0 0 20px 0',
    textAlign: 'center'
  });
  mainPanel.add(subtitleLabel);
  
  // 创建功能区面板
  var functionsPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '100%',
      padding: '10px'
    }
  });
  
  // 功能1: 葡萄种植适宜性分析
  var function1Panel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {
      width: '100%',
      padding: '10px',
      margin: '0 0 10px 0',
      border: '1px solid #ddd',
      borderRadius: '5px'
    }
  });
  
  var function1Icon = ui.Label('🍇', {
    fontSize: '36px',
    margin: '0 20px 0 10px'
  });
  
  var function1Details = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '70%'
    }
  });
  
  var function1Title = ui.Label('葡萄种植适宜性分析', {
    fontWeight: 'bold',
    fontSize: '16px',
    margin: '0 0 5px 0'
  });
  
  var function1Description = ui.Label('分析不同区域和年份的葡萄种植适宜性，查看历史数据和趋势变化', {
    fontSize: '13px'
  });
  
  function1Details.add(function1Title);
  function1Details.add(function1Description);
  
  var function1Button = ui.Button({
    label: '启动',
    onClick: function() {
      startGrapeAnalysis();
    },
    style: {
      padding: '8px 16px',
      margin: '10px 0 0 0'
    }
  });
  
  function1Panel.add(function1Icon);
  function1Panel.add(function1Details);
  function1Panel.add(function1Button);
  
  // 功能2: 占位符功能
  var function2Panel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {
      width: '100%',
      padding: '10px',
      margin: '0 0 10px 0',
      border: '1px solid #ddd',
      borderRadius: '5px'
    }
  });
  
  var function2Icon = ui.Label('🌦️', {
    fontSize: '36px',
    margin: '0 20px 0 10px'
  });
  
  var function2Details = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '70%'
    }
  });
  
  var function2Title = ui.Label('气候影响分析工具', {
    fontWeight: 'bold',
    fontSize: '16px',
    margin: '0 0 5px 0'
  });
  
  var function2Description = ui.Label('分析气候变化对葡萄种植的长期影响（开发中）', {
    fontSize: '13px'
  });
  
  function2Details.add(function2Title);
  function2Details.add(function2Description);
  
  var function2Button = ui.Button({
    label: '即将推出',
    style: {
      padding: '8px 16px',
      margin: '10px 0 0 0',
      color: '#999',
      backgroundColor: '#f0f0f0'
    }
  });
  
  function2Panel.add(function2Icon);
  function2Panel.add(function2Details);
  function2Panel.add(function2Button);
  
  // 添加功能到功能面板
  functionsPanel.add(function1Panel);
  functionsPanel.add(function2Panel);
  
  // 添加功能面板到主面板
  mainPanel.add(functionsPanel);
  
  // 添加页脚
  var footerLabel = ui.Label('© 2023 葡萄种植分析系统', {
    fontSize: '12px',
    textAlign: 'center',
    margin: '20px 0 0 0',
    color: '#666'
  });
  mainPanel.add(footerLabel);
  
  // 将主面板添加到根
  ui.root.add(mainPanel);
}

// =========== Part 4: 葡萄种植适宜性分析页面 ===========

// 客户端处理county列表
var regionNamesRaw = [];
var suitableNames = [];
var unsuitableNames = [];
var unsuitableGeomsList = [];
var finalRegionNames = [];

// 启动葡萄种植适宜性分析
function startGrapeAnalysis() {
  // 切换到分析页面
  currentPage = "grapeAnalysis";
  
  // 清除当前UI
  ui.root.clear();
  
  // 创建地图面板（全屏效果）
  mapPanel = ui.Map();
  ui.root.add(mapPanel);
  mapPanel.setControlVisibility({
    zoomControl: false,
    scaleControl: false,
    mapTypeControl: false,
    fullscreenControl: true
  });
  mapPanel.style().set({position: 'top-left', width: '100%', height: '100%'});

  // 创建控制面板（加宽版）
  controlPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '400px', 
      position: 'top-right', 
      padding: '8px', 
      backgroundColor: 'white',
      maxHeight: '90%'  // 限制最大高度
    }
  });
  mapPanel.add(controlPanel);
  
  // 添加返回按钮
  var backButton = ui.Button({
    label: '返回主页',
    onClick: createHomePage,
    style: {
      padding: '8px',
      margin: '0 0 10px 0'
    }
  });
  controlPanel.add(backButton);
  
  // 添加初始化消息
  controlPanel.add(ui.Label('正在初始化葡萄种植适宜性分析...', {
    fontWeight: 'bold',
    textAlign: 'center',
    padding: '10px'
  }));
  
  // 预加载区域名称
  regionNamesRaw = ukLevel2.aggregate_array('ADM2_NAME').getInfo();
  
  // 重置数据
  suitableNames = [];
  unsuitableNames = [];
  unsuitableGeomsList = [];
  finalRegionNames = [];
  currentCountyName = 'Kent';
  
  // 启动初始化过程
  initializeRegions();
}

// 快速加载Kent区域，然后在后台加载其他区域
function initializeRegions() {
  showLoading("加载Kent区域数据...");
  
  // 先找到Kent区域的索引
  var kentIndex = -1;
  for (var i = 0; i < regionNamesRaw.length; i++) {
    if (regionNamesRaw[i] === 'Kent') {
      kentIndex = i;
      break;
    }
  }
  
  // 如果找不到Kent，使用第一个区域
  if (kentIndex === -1) {
    kentIndex = 0;
    currentCountyName = regionNamesRaw[0];
  } else {
    currentCountyName = 'Kent';
  }
  
  // 先只加载Kent区域
  var county = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', currentCountyName)).first();
  var geom = county.geometry();
  var checkYear = '2023';
  
  var mask = computeMask(geom, checkYear);
  
  // 异步计算Kent区域面积
  mask.multiply(ee.Image.pixelArea())
    .reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: geom,
      scale: 250,
      maxPixels: 1e10
    })
    .evaluate(function(result) {
      var area = result ? result.mask : 0;
      var hasArea = area > 0;
      
      // 将Kent添加到适当列表
      if (hasArea) {
        suitableNames.push(currentCountyName);
      } else {
        unsuitableNames.push(currentCountyName);
        unsuitableGeomsList.push(geom);
      }
      
      // 临时初始化区域列表，只包含Kent
      finalRegionNames = suitableNames.slice();
      
      // 构建UI，显示Kent数据
      hideLoading();
      rebuildMainPanel();
      
      // 开始在后台加载其他区域
      backgroundLoadingInProgress = true;
      continueLoadingRegions(0, kentIndex);
    });
}

// 继续在后台加载其他区域
function continueLoadingRegions(startIdx, skipIdx) {
  // 如果已经处理完所有区域，完成后台加载
  if (startIdx >= regionNamesRaw.length) {
    finalizeRegionLists();
    return;
  }
  
  // 跳过已经处理的Kent区域
  if (startIdx === skipIdx) {
    continueLoadingRegions(startIdx + 1, skipIdx);
    return;
  }
  
  var name = regionNamesRaw[startIdx];
  var county = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', name)).first();
  var geom = county.geometry();
  var checkYear = '2023';
  
  // 保存当前的currentCountyName
  var savedCurrentCountyName = currentCountyName;
  currentCountyName = name; // 临时设置为当前处理的区域
  
  var mask = computeMask(geom, checkYear);
  
  // 显示后台进度
  showBackgroundLoading("后台加载区域: " + (startIdx + 1) + "/" + regionNamesRaw.length);
  
  // 异步计算面积
  mask.multiply(ee.Image.pixelArea())
    .reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: geom,
      scale: 250,
      maxPixels: 1e10
    })
    .evaluate(function(result) {
      var area = result ? result.mask : 0;
      var hasArea = area > 0;
      
      if (hasArea) {
        suitableNames.push(name);
      } else {
        unsuitableNames.push(name);
        unsuitableGeomsList.push(geom);
      }
      
      // 恢复原来的currentCountyName
      currentCountyName = savedCurrentCountyName;
      
      // 继续处理下一个区域
      ee.Number(1).evaluate(function() {
        continueLoadingRegions(startIdx + 1, skipIdx);
      });
    });
}

// 完成所有区域的加载
function finalizeRegionLists() {
  // 更新最终区域列表
  finalRegionNames = suitableNames.slice();
  if (unsuitableNames.length > 0) {
    finalRegionNames.push('Unsuitable for 3 Years');
  }
  
  backgroundLoadingInProgress = false;
  hideBackgroundLoading();
  
  // 如果用户处于查看区域表格的状态，更新表格
  var isViewingTable = controlPanel.widgets().length() > 0 && 
                        controlPanel.widgets().get(0).getValue && 
                        controlPanel.widgets().get(0).getValue() === 'County Table (Click to Select)';
  
  if (isViewingTable) {
    showCountyTable();
  }
}

// 主界面重建
function rebuildMainPanel() {
  controlPanel.clear();
  
  // 添加返回按钮
  var backButton = ui.Button({
    label: '返回主页',
    onClick: createHomePage,
    style: {
      padding: '8px',
      margin: '0 0 10px 0'
    }
  });
  controlPanel.add(backButton);

  // 如果后台加载正在进行，显示状态
  if (backgroundLoadingInProgress) {
    showBackgroundLoading("区域数据加载中...");
  }

  // 1. County选择部分
  controlPanel.add(ui.Label('1. 选择区域 (输入名称或查看表格)', {fontWeight: 'bold'}));

  var viewTableButton = ui.Button({
    label: '查看区域表格',
    onClick: showCountyTable
  });
  controlPanel.add(viewTableButton);

  // 创建一个水平面板来放置输入框和确认按钮
  var inputPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%'}
  });

  countyInput = ui.Textbox({
    placeholder: '输入区域名称...',
    value: currentCountyName,
    style: {width: '300px'}
  });

  var confirmButton = ui.Button({
    label: '确认',
    onClick: function() {
      var name = countyInput.getValue();
      if (finalRegionNames.indexOf(name) !== -1) {
        currentCountyName = name;
        showLoading("更新区域数据...");
        // 使用evaluate延迟执行
        ee.Number(1).evaluate(function() {
          updateRegion();
          hideLoading();
        });
      } else {
        print('⚠️ 未找到区域: ' + name);
      }
    }
  });

  inputPanel.add(countyInput);
  inputPanel.add(confirmButton);
  controlPanel.add(inputPanel);

  // 2. 面积图表部分
  controlPanel.add(ui.Label('2. 适宜区域面积 (km²)', {fontWeight: 'bold'}));
  chartPanel = ui.Panel();
  controlPanel.add(chartPanel);

  // 3. 视图模式部分
  controlPanel.add(ui.Label('3. 查看模式', {fontWeight: 'bold'}));

  // 创建一个水平面板来放置两个按钮
  var buttonPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%', margin: '4px 0'}
  });

  var singleYearButton = ui.Button({
    label: '单年查看',
    onClick: function() {
      modeSelect = 'Single Year';
      updateViewMode();
    },
    style: {
      margin: '0 8px 0 0',
      width: '180px'
    }
  });

  var multiYearButton = ui.Button({
    label: '多年分析',
    onClick: function() {
      modeSelect = 'Multi-Year';
      updateViewMode();
    },
    style: {
      width: '180px'
    }
  });

  buttonPanel.add(singleYearButton);
  buttonPanel.add(multiYearButton);
  controlPanel.add(buttonPanel);

  // 单年模式的滑块
  yearSlider = ui.Slider({
    min: 2010, max: 2023, value: 2023, step: 1,
    onChange: function() { 
      if (currentRegion) {
        showLoading("更新年份数据...");
        // 使用evaluate延迟执行
        ee.Number(1).evaluate(function() {
          updateYearlyMap(currentRegion, yearSlider.getValue());
          hideLoading();
        });
      }
    },
    style: {width: '350px'}
  });

  // 多年模式的输入框面板
  yearInputPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%', margin: '4px 0'}
  });

  // 创建一个水平面板专门放置From和To输入框
  var yearInputsContainer = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%', margin: '0'}
  });

  var fromLabel = ui.Label('起始年份:', {margin: '4px 4px 0 0'});
  startYearInput = ui.Textbox({
    placeholder: '2021',
    style: {width: '80px', margin: '0 8px 0 0'}
  });

  var toLabel = ui.Label('结束年份:', {margin: '4px 4px 0 0'});
  endYearInput = ui.Textbox({
    placeholder: '2023',
    style: {width: '80px'}
  });

  yearInputsContainer.add(fromLabel);
  yearInputsContainer.add(startYearInput);
  yearInputsContainer.add(toLabel);
  yearInputsContainer.add(endYearInput);
  yearInputPanel.add(yearInputsContainer);

  // 添加滑块和年份输入面板
  controlPanel.add(yearSlider);
  controlPanel.add(yearInputPanel);

  // 默认隐藏多年输入面板
  yearInputPanel.style().set('shown', false);

  var updateButton = ui.Button({
    label: '更新地图',
    onClick: function() {
      if (!currentRegion) return;
      
      if (modeSelect === 'Single Year') {
        showLoading("更新地图...");
        // 使用evaluate延迟执行
        ee.Number(1).evaluate(function() {
          updateYearlyMap(currentRegion, yearSlider.getValue());
          hideLoading();
        });
      } else {
        var s = parseInt(startYearInput.getValue());
        var e = parseInt(endYearInput.getValue());
        if (isNaN(s) || isNaN(e) || s >= e) {
          return;
        }
        showLoading("分析多年数据...");
        // 使用evaluate延迟执行
        ee.Number(1).evaluate(function() {
          showPersistentSuitability(currentRegion, s, e);
          hideLoading();
        });
      }
    }
  });
  controlPanel.add(updateButton);

  // 4. 图层控制部分
  controlPanel.add(ui.Label('4. 图层控制', {fontWeight: 'bold', margin: '12px 0 4px'}));

  // 添加图例面板
  var legendPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      padding: '8px',
      margin: '0 0 8px 0',
      backgroundColor: 'white'
    }
  });

  // 添加各个图层的复选框和图例
  checkboxRegion = ui.Checkbox({
    label: '', 
    value: true, 
    onChange: function() {
      showLoading("更新地图...");
      // 使用evaluate延迟执行
      ee.Number(1).evaluate(function() {
        updateRegion();
        hideLoading();
      });
    }
  });
  var regionRow = ui.Panel([checkboxRegion, createLegendRow('orange', '区域边界')], 
    ui.Panel.Layout.flow('horizontal'));
  legendPanel.add(regionRow);

  checkboxSuitability = ui.Checkbox({
    label: '', 
    value: true, 
    onChange: function() {
      showLoading("更新地图...");
      // 使用evaluate延迟执行
      ee.Number(1).evaluate(function() {
        updateRegion();
        hideLoading();
      });
    }
  });
  var suitabilityRow = ui.Panel([checkboxSuitability, createLegendRow('#00FF00', '适宜种植区域')],
    ui.Panel.Layout.flow('horizontal'));
  legendPanel.add(suitabilityRow);

  checkboxVineyards = ui.Checkbox({
    label: '', 
    value: true, 
    onChange: function() {
      showLoading("更新地图...");
      // 使用evaluate延迟执行
      ee.Number(1).evaluate(function() {
        updateRegion();
        hideLoading();
      });
    }
  });
  var vineyardsRow = ui.Panel([checkboxVineyards, createLegendRow('purple', '现有葡萄园 (2023)')],
    ui.Panel.Layout.flow('horizontal'));
  legendPanel.add(vineyardsRow);

  controlPanel.add(legendPanel);

  // 更新区域
  currentRegion = getRegionGeometry(currentCountyName);
  updateRegion();
}

// 更新视图模式
function updateViewMode() {
  if (modeSelect === 'Single Year') {
    yearSlider.style().set('shown', true);
    yearInputPanel.style().set('shown', false);
  } else {
    yearSlider.style().set('shown', false);
    yearInputPanel.style().set('shown', true);
  }
}

// 更新地图区域 - 分批处理年度数据
function updateRegion() {
  chartPanel.clear();
  mapPanel.layers().reset();
  yearSlider.setValue(2023);
  
  if (!currentRegion) {
    currentRegion = getRegionGeometry(currentCountyName);
  }

  mapPanel.centerObject(currentRegion, 8);

  if (checkboxRegion.getValue()) {
    mapPanel.addLayer(currentRegion, {
      color: 'orange',
      fillColor: '00000000',
      width: 2
    }, 'Selected Region');
  }

  // 分批处理年度数据来构建图表
  var years = ee.List.sequence(2010, 2023).getInfo();
  var batchSize = 4; // 每批处理4年数据
  var features = [];
  
  showLoading("构建时间序列图表...");
  processBatch(0);
  
  function processBatch(startIdx) {
    if (startIdx >= years.length) {
      // 所有批次处理完毕，创建图表
      finishChart();
      return;
    }
    
    var endIdx = Math.min(startIdx + batchSize, years.length);
    var batchYears = years.slice(startIdx, endIdx);
    
    showLoading("构建时间序列图表... (" + endIdx + "/" + years.length + ")");
    
    // 处理这一批年份
    var batchFeatures = batchYears.map(function(y) {
      var mask = computeMask(currentRegion, String(y));
      var area = computeArea(mask, currentRegion);
      return ee.Feature(null, {year: y, area_km2: ee.Number(area).divide(1e6)});
    });
    
    features = features.concat(batchFeatures);
    
    // 使用GEE异步机制处理下一批
    ee.Number(1).evaluate(function() {
      processBatch(endIdx);
    });
  }
  
  function finishChart() {
    // 创建时间序列图表
    var ts = ee.FeatureCollection(features);
    var chart = ui.Chart.feature.byFeature(ts, 'year', 'area_km2')
      .setChartType('LineChart')
      .setOptions({
        title: '多年适宜区域面积',
        hAxis: {title: '年份', format: '####'},
        vAxis: {title: '面积 (km²)'},
        lineWidth: 2,
        pointSize: 5,
        height: 220,
        series: {0: {color: '#228B22'}},
        backgroundColor: {fill: 'white'},
        legend: {position: 'none'}
      });
    chartPanel.add(chart);
    
    // 添加2023年适宜性图层
    if (checkboxSuitability.getValue()) {
      var m = computeMask(currentRegion, '2023');
      mapPanel.addLayer(m.selfMask(), {
        palette: ['#00FF00'],
        opacity: 0.7
      }, 'Suitability 2023');
    }
    
    // 添加葡萄园图层
    if (checkboxVineyards.getValue()) {
      mapPanel.addLayer(vineyards.filterBounds(currentRegion), {
        color: 'purple',
        width: 2,
        fillColor: '800080AA'
      }, 'Vineyards (2023)');
    }
    
    hideLoading();
  }
}

// 单年模式
function updateYearlyMap(region, year) {
  mapPanel.layers().reset();

  if (checkboxRegion.getValue()) {
    mapPanel.addLayer(region, {
      color: 'orange',
      fillColor: '00000000',
      width: 2
    }, 'Selected Region');
  }

  var mask = computeMask(region, String(year));
  mapPanel.addLayer(mask.selfMask(), {
    palette: ['#228B22'],
    opacity: 0.7
  }, 'Suitability ' + year);

  if (checkboxVineyards.getValue()) {
    mapPanel.addLayer(vineyards.filterBounds(region), {
      color: 'purple',
      width: 2,
      fillColor: '800080AA'
    }, 'Vineyards (2023)');
  }
}

// 多年一致适宜 - 分批处理年份
function showPersistentSuitability(region, startYear, endYear) {
  mapPanel.layers().reset();

  if (checkboxRegion.getValue()) {
    mapPanel.addLayer(region, {
      color: 'orange',
      fillColor: '00000000',
      width: 2
    }, 'Selected Region');
  }

  // 分批处理年份
  var totalYears = endYear - startYear + 1;
  var batchSize = 3; // 每批处理3年
  var maskImages = [];
  
  processYearBatch(startYear);
  
  function processYearBatch(currentYear) {
    if (currentYear > endYear) {
      // 所有年份处理完毕
      finalizePersistentMap();
      return;
    }
    
    var endYearBatch = Math.min(currentYear + batchSize - 1, endYear);
    showLoading("处理年份 " + currentYear + " 到 " + endYearBatch + " (" + 
               (endYearBatch - startYear + 1) + "/" + totalYears + ")");
    
    // 处理这一批年份
    for (var y = currentYear; y <= endYearBatch; y++) {
      maskImages.push(computeMask(region, String(y)));
    }
    
    // 使用GEE异步机制处理下一批
    ee.Number(1).evaluate(function() {
      processYearBatch(endYearBatch + 1);
    });
  }
  
  function finalizePersistentMap() {
    var allYears = ee.ImageCollection(maskImages).reduce(ee.Reducer.allNonZero());
    mapPanel.addLayer(allYears.selfMask(), {
      palette: ['#006400'],
      opacity: 0.8
    }, 'Persistent ' + startYear + '-' + endYear);

    if (checkboxVineyards.getValue()) {
      mapPanel.addLayer(vineyards.filterBounds(region), {
        color: 'purple',
        width: 2,
        fillColor: '800080AA'
      }, 'Vineyards (2023)');
    }
    
    hideLoading();
  }
}

// 显示County表格
function showCountyTable() {
  controlPanel.clear();
  
  // 添加返回按钮
  var backButton = ui.Button({
    label: '返回主页',
    onClick: createHomePage,
    style: {
      padding: '8px',
      margin: '0 0 10px 0'
    }
  });
  controlPanel.add(backButton);
  
  controlPanel.add(ui.Label('区域列表 (点击选择)', {fontWeight: 'bold'}));

  var grid = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'), 
    style: {width: '380px', height: '400px', padding: '8px'}
  });
  
  // 如果后台加载正在进行，显示状态
  if (backgroundLoadingInProgress) {
    showBackgroundLoading("区域数据加载中...");
  }
  
  showLoading("加载区域列表...");
  
  // 使用GEE异步机制加载表格
  ee.Number(1).evaluate(function() {
    var row = ui.Panel({
      layout: ui.Panel.Layout.flow('horizontal'), 
      style: {width: '380px'}
    });
    var count = 0;

    suitableNames.forEach(function(name) {
      var label = ui.Button({
        label: name,
        onClick: function() {
          currentCountyName = name;
          rebuildMainPanel();
        }
      });
      label.style().set('width', '120px');
      row.add(label);
      count++;
      if (count % 3 === 0) {
        grid.add(row);
        row = ui.Panel({
          layout: ui.Panel.Layout.flow('horizontal'), 
          style: {width: '380px'}
        });
      }
    });

    if (count % 3 !== 0) {
      grid.add(row);
    }

    if (unsuitableNames.length > 0) {
      grid.add(ui.Label(' '));
      var unsuitBtn = ui.Button({
        label: '不适宜区域',
        onClick: function() {
          currentCountyName = 'Unsuitable for 3 Years';
          rebuildMainPanel();
        }
      });
      unsuitBtn.style().set('width', '380px');
      grid.add(unsuitBtn);
    }

    var closeButton = ui.Button({
      label: '返回',
      onClick: rebuildMainPanel
    });
    grid.add(closeButton);

    controlPanel.add(grid);
    hideLoading();
  });
}

// =========== Part 5: 启动应用 ===========

// 启动主页面
createHomePage();
