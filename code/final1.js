
  // ---- 1. Load UK Administrative Division Data ----
  var ukLevel1 = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level1")
    .filter(ee.Filter.eq('ADM0_NAME', 'U.K. of Great Britain and Northern Ireland'));
    
  var ukLevel2 = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level2")
    .filter(ee.Filter.eq('ADM0_NAME', 'U.K. of Great Britain and Northern Ireland'));
  
  // Define regions using actual administrative boundaries
  var regions = {};
  
  // Define UK regions using actual administrative boundaries, divided into smaller areas suitable for computation
  // Counties in Southern England
  regions['Kent'] = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', 'Kent')).geometry();

  // Initial setting to Southeast England
  var analysisRegion = regions['Kent'];
  
  // Display UK boundary
  var UK = ukLevel1.geometry();
  Map.addLayer(UK, {color: 'red', width: 1}, "UK Boundary", false);
  
  // ---- 2. Function Definitions ----
 
  
  // Clear map layers function
  function clearMapLayers() {
    var layersToRemove = [
      'Analysis Region',
      'Growing Season Temperature (GST)',
      'Growing Degree Days (GDD)',
      'Growing Season Precipitation (GSP)',
      'Slope',
      'Suitable Areas Based on Environmental Factors',
      'Existing Vineyards',
      'Grape Growing Suitability Probability',
      'High Suitability Areas (>70%)'
    ];
    
    // Find and remove all matching layers
    Map.layers().forEach(function(layer) {
      var name = layer.getName();
      if (layersToRemove.indexOf(name) !== -1) {
        Map.remove(layer);
      }
    });
  }

  

// ===== 1. Independent Machine Learning Module =====

/**
 * Grape Growing Suitability Analysis Module - Core Machine Learning Functionality
 * 
 */
var GrapeML = {
  
  /**
   * Calculate Environmental Factors
   * @param {ee.Geometry} region - Analysis region
   * @param {string} year - Analysis year
   * @return {Object} Object containing various environmental factors
   */
  computeEnvironmentalFactors: function(region, year) {
    var results = {};
    
    // GST - Growing Season Temperature
    results.gst = this.computeGST(year).clip(region);
    
    // GDD - Growing Degree Days
    results.gdd = this.computeGDD(year, 10, 30).clip(region);
    
    // GSP - Growing Season Precipitation
    results.gsp = this.computeGSP(year).clip(region);
    
    // Terrain Factors
    var dem = ee.Image('USGS/SRTMGL1_003').clip(region);
    results.slope = ee.Terrain.slope(dem);
    results.aspect = ee.Terrain.aspect(dem);
    results.elevation = dem.select('elevation');
    
    // Latitude
    results.latitude = ee.Image.pixelLonLat().select('latitude').clip(region);
    
    return results;
  },
  
  /**
   * Calculate Growing Season Temperature (GST)
   * @param {string} year - Analysis year
   * @return {ee.Image} GST image
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
   * Calculate Growing Degree Days (GDD)
   * @param {string} year - Analysis year
   * @param {number} baseTemp - Base temperature
   * @param {number} daysPerMonth - Number of days per month
   * @return {ee.Image} GDD image
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
   * Calculate Growing Season Precipitation (GSP)
   * @param {string} year - Analysis year
   * @return {ee.Image} GSP image
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
   * Generate Environmental Suitability Mask
   * @param {Object} factors - Environmental factors object
   * @return {ee.Image} Environmental suitability mask
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
 * Run Machine Learning Prediction
 * @param {Object} factors - Environmental factors object
 * @param {ee.Image} suitabilityMask - Environmental suitability mask
 * @param {ee.Geometry} region - Analysis region
 * @param {ee.FeatureCollection} vineyards - Vineyard data
 * @return {Object} Machine learning results object
 */
runMachineLearning: function(factors, suitabilityMask, region, vineyards) {
  try {
    // Build feature image
    var featureImage = ee.Image.cat([
      factors.gst.rename('GST'),
      factors.gdd.rename('GDD'),
      factors.gsp.rename('GSP'),
      factors.slope.rename('slope'),
      factors.aspect.rename('aspect'),
      factors.elevation.rename('elevation'),
      factors.latitude.rename('latitude')
    ]).clip(region);
    
    // Clip to analysis region
    var regionalVineyards = vineyards.filterBounds(region);
    
    // Check if there are enough vineyard data
    var vineyardCount = regionalVineyards.size().getInfo();
    print("Number of vineyards in the region:", vineyardCount);
    
    if (vineyardCount < 5) {
      return {
        success: false,
        error: 'Insufficient vineyard data in the selected region for machine learning prediction',
        suitabilityMask: suitabilityMask // Return basic suitability mask as alternative result
      };
    }
    
    // Generate positive sample points
    var positivePointCount = Math.min(vineyardCount * 10, 200);
    print("Number of positive sample points:", positivePointCount);
    
    var positivePoints = ee.FeatureCollection.randomPoints({
      region: regionalVineyards.geometry(),
      points: positivePointCount,
      seed: 123
    }).map(function(feature) {
      return feature.set('class', 1);
    });
    
    // Check if positive sample points were successfully generated
    var actualPositiveCount = positivePoints.size().getInfo();
    print("Actual number of positive sample points generated:", actualPositiveCount);
    
    if (actualPositiveCount < 5) {
      return {
        success: false,
        error: 'Unable to generate sufficient positive sample points',
        suitabilityMask: suitabilityMask
      };
    }
    
    // Generate negative sample points
    var nonSuitableArea = suitabilityMask.not();
    var negativePoints = ee.FeatureCollection.randomPoints({
      region: region,
      points: 400,
      seed: 456
    }).filter(ee.Filter.bounds(nonSuitableArea.selfMask().geometry()))
      .map(function(feature) {
        return feature.set('class', 0);
      });
    
    // Check if negative sample points were successfully generated
    var actualNegativeCount = negativePoints.size().getInfo();
    print("Actual number of negative sample points generated:", actualNegativeCount);
    
    if (actualNegativeCount < 5) {
      return {
        success: false,
        error: 'Unable to generate sufficient negative sample points',
        suitabilityMask: suitabilityMask
      };
    }
    
    // Merge all samples
    var allPoints = positivePoints.merge(negativePoints);
    
    // Extract feature values
    var sampledPoints = featureImage.sampleRegions({
      collection: allPoints,
      properties: ['class'],
      scale: 100,
      tileScale: 16  // Increase tileScale to handle large areas
    });
    
    // Check if feature extraction was successful
    var sampleCount = sampledPoints.size().getInfo();
    print("Number of sample points with successfully extracted features:", sampleCount);
    
    if (sampleCount < 10) {
      return {
        success: false,
        error: 'Feature extraction failed, insufficient sample points',
        suitabilityMask: suitabilityMask
      };
    }
    
    // Split into training and testing sets
    sampledPoints = sampledPoints.randomColumn();
    var training = sampledPoints.filter(ee.Filter.lt('random', 0.7));
    var testing = sampledPoints.filter(ee.Filter.gte('random', 0.7));
    
    // Check training and testing sets
    var trainingCount = training.size().getInfo();
    var testingCount = testing.size().getInfo();
    print("Training set size:", trainingCount);
    print("Testing set size:", testingCount);
    
    if (trainingCount < 5 || testingCount < 5) {
      return {
        success: false,
        error: 'Insufficient training or testing set size',
        suitabilityMask: suitabilityMask
      };
    }
    
    // Train the model
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
    
    // Evaluate the model
    var validation = testing.classify(classifier);
    
    // Create a more robust error handling mechanism to calculate accuracy
    var accuracy;
    try {
      var errorMatrix = validation.errorMatrix('class', 'classification');
      accuracy = errorMatrix.accuracy();
      
      // Get detailed information from the confusion matrix
      var confMatrix = errorMatrix.array().getInfo();
      print("Confusion Matrix:", confMatrix);
      
      // Check if the accuracy is a valid number
      if (isNaN(accuracy.getInfo())) {
        print("Warning: Calculated accuracy is NaN, using alternative method to calculate");
        // Try to manually calculate accuracy
        var correct = validation.filter(ee.Filter.eq('class', 'classification')).size();
        var total = validation.size();
        accuracy = ee.Number(correct).divide(total);
      }
    } catch (error) {
      print("Error calculating accuracy:", error);
      accuracy = ee.Number(0);  // Set default value
    }
    
    // Predict
    var probabilityClassifier = classifier.setOutputMode('PROBABILITY');
    var suitabilityScore = featureImage.classify(probabilityClassifier)
                         .select('classification')
                         .reproject({crs: 'EPSG:4326', scale: 250});
    
    // High suitability areas (probability > 0.7)
    var highSuitabilityAreas = suitabilityScore.gt(0.7);
    
    // Calculate high suitability area size
    var areaCalculation = highSuitabilityAreas.multiply(ee.Image.pixelArea())
                        .reduceRegion({
                          reducer: ee.Reducer.sum(),
                          geometry: region,
                          scale: 250,
                          maxPixels: 1e9
                        });
    
    // Get feature importance
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
      sampledPoints: sampledPoints,  // Return sample points for debugging
      positiveCount: actualPositiveCount,
      negativeCount: actualNegativeCount
    };
    
  } catch (error) {
    print("Error during machine learning analysis:", error);
    return {
      success: false,
      error: error.message,
      suitabilityMask: suitabilityMask
    };
  }
},
  
  /**
   * Execute complete grape cultivation suitability analysis
   * @param {ee.Geometry} region - Analysis region
   * @param {string} year - Analysis year
   * @return {Object} Analysis result object
   */
  analyzeSuitability: function(region, year) {
    // Load vineyard data
    var vineyards = ee.FeatureCollection("projects/ee-cesong333/assets/existing_vineyards");
    
    // Calculate environmental factors
    var factors = this.computeEnvironmentalFactors(region, year);
    
    // Calculate environmental suitability mask
    var suitabilityMask = this.computeSuitabilityMask(factors);
    
    // Execute machine learning prediction
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




// =========== Part 1: Global Variable Declaration ===========
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

// Load administrative region data - preload in global scope
var ukLevel2 = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level2")
  .filter(ee.Filter.eq('ADM0_NAME', 'U.K. of Great Britain and Northern Ireland'));

// Define UK boundary for Module 3
var UK_boundary = ukLevel2.union();

// Load vineyard data - preload in global scope
var vineyards = ee.FeatureCollection("projects/ee-cesong333/assets/existing_vineyards");

// Define global variable to store feature page state
var currentPage = "home";

// =========== Part 2: Function Definitions ===========

// Define computeMask
function computeMask(region, year) {
  // Calculate mask
  var factors = GrapeML.computeEnvironmentalFactors(region, year);
  var mask = GrapeML.computeSuitabilityMask(factors).rename('mask').clip(region);
  return mask;
}

// Show loading status
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

// Show background loading progress
function showBackgroundLoading(message) {
  // If there's already a main loading indicator, don't show background loading
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

// Hide background loading status
function hideBackgroundLoading() {
  if (bgLoadingLabel && controlPanel) {
    controlPanel.remove(bgLoadingLabel);
    bgLoadingLabel = null;
  }
}

// Hide loading status
function hideLoading() {
  if (loadingLabel && controlPanel) {
    controlPanel.remove(loadingLabel);
    loadingLabel = null;
  }
}

// Utility functions 
function computeArea(mask, region) {
  // Calculate area
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

// Helper function to create legend row
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

// =========== Part 3: Main Page ===========

// Create main page
function createHomePage() {
  ui.root.clear();
  currentPage = "home";
  
  // Create a panel to hold all content
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
  
  // Add title
  var titleLabel = ui.Label('Grape Cultivation Analysis Toolkit', {
    fontWeight: 'bold',
    fontSize: '24px',
    margin: '10px 0 20px 0',
    textAlign: 'center'
  });
  mainPanel.add(titleLabel);
  
  // Add subtitle
  var subtitleLabel = ui.Label('Please select a function to use:', {
    fontSize: '16px',
    margin: '0 0 20px 0',
    textAlign: 'center'
  });
  mainPanel.add(subtitleLabel);
  
  // Create function panel
  var functionsPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '100%',
      padding: '10px'
    }
  });
  
  // Function 1: Grape Cultivation Suitability Analysis
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
  
  var function1Title = ui.Label('Grape Cultivation Suitability Analysis', {
    fontWeight: 'bold',
    fontSize: '16px',
    margin: '0 0 5px 0'
  });
  
  var function1Description = ui.Label('Analyze the suitability of grape cultivation in different regions and years, view historical data and trend changes', {
    fontSize: '13px'
  });
  
  function1Details.add(function1Title);
  function1Details.add(function1Description);
  
  var function1Button = ui.Button({
    label: 'Launch',
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
  
  // Function 3: Regional Comparison Analysis
  var function3Panel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {
      width: '100%',
      padding: '10px',
      margin: '0 0 10px 0',
      border: '1px solid #ddd',
      borderRadius: '5px'
    }
  });
  
  var function3Icon = ui.Label('📊', {
    fontSize: '36px',
    margin: '0 20px 0 10px'
  });
  
  var function3Details = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '70%'
    }
  });
  
  var function3Title = ui.Label('Regional Comparison Analysis', {
    fontWeight: 'bold',
    fontSize: '16px',
    margin: '0 0 5px 0'
  });
  
  var function3Description = ui.Label('Select and compare grape cultivation suitability across different regions, analyze regional differences', {
    fontSize: '13px'
  });
  
  function3Details.add(function3Title);
  function3Details.add(function3Description);
  
  var function3Button = ui.Button({
    label: 'Launch',
    onClick: function() {
      startRegionalComparison();
    },
    style: {
      padding: '8px 16px',
      margin: '10px 0 0 0'
    }
  });
  
  function3Panel.add(function3Icon);
  function3Panel.add(function3Details);
  function3Panel.add(function3Button);
  
  // Function 2: Placeholder Function
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
  
 
  
  
  

  
  // Add functions to function panel
  functionsPanel.add(function1Panel);
  functionsPanel.add(function3Panel);  // Add regional comparison function

  // Add function panel to main panel
  mainPanel.add(functionsPanel);
  
  // Add footer
  var footerLabel = ui.Label('© 2023 Grape Cultivation Analysis System', {
    fontSize: '12px',
    textAlign: 'center',
    margin: '20px 0 0 0',
    color: '#666'
  });
  mainPanel.add(footerLabel);
  
  // Add main panel to root
  ui.root.add(mainPanel);
}

// =========== Part 4: Grape Cultivation Suitability Analysis Page ===========

// Client-side processing of county list
var regionNamesRaw = [];
var suitableNames = [];
var unsuitableNames = [];
var unsuitableGeomsList = [];
var finalRegionNames = [];

// Start grape cultivation suitability analysis
function startGrapeAnalysis() {
  // Switch to analysis page
  currentPage = "grapeAnalysis";
  
  // Clear current UI
  ui.root.clear();
  
  // Create map panel (full screen effect)
  mapPanel = ui.Map();
  ui.root.add(mapPanel);
  mapPanel.setControlVisibility({
    zoomControl: false,
    scaleControl: false,
    mapTypeControl: false,
    fullscreenControl: true
  });
  mapPanel.style().set({position: 'top-left', width: '100%', height: '100%'});

  // Create control panel (wide version)
  controlPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '400px', 
      position: 'top-right', 
      padding: '8px', 
      backgroundColor: 'white',
      maxHeight: '90%'  // Limit maximum height
    }
  });
  mapPanel.add(controlPanel);
  
  // Add return button
  var backButton = ui.Button({
    label: 'Home',
    onClick: createHomePage,
    style: {
      padding: '8px',
      margin: '0 0 10px 0'
    }
  });
  controlPanel.add(backButton);
  
  // Add initialization message
  controlPanel.add(ui.Label('Initializing grape cultivation suitability analysis...', {
    fontWeight: 'bold',
    textAlign: 'center',
    padding: '10px'
  }));
  
  // Preload region names
  regionNamesRaw = ukLevel2.aggregate_array('ADM2_NAME').getInfo();
  
  // Reset data
  suitableNames = [];
  unsuitableNames = [];
  unsuitableGeomsList = [];
  finalRegionNames = [];
  currentCountyName = 'Kent';
  
  // Start initialization process
  initializeRegions();
}

// =========== Part 5: Regional Comparison Function (Module 3) ===========

// Start regional comparison analysis
function startRegionalComparison() {
  // Switch to regional comparison page
  currentPage = "regionalComparison";
  
  // Clear current UI
  ui.root.clear();
  // Create map panel
  mapPanel = ui.Map();
  ui.root.add(mapPanel);
  mapPanel.setControlVisibility({
    zoomControl: true,
    scaleControl: true,
    mapTypeControl: true,
    fullscreenControl: true
  });
  mapPanel.style().set({position: 'top-left', width: '100%', height: '100%'});

  // Create control panel
  controlPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '400px', 
      position: 'top-right', 
      padding: '8px', 
      backgroundColor: 'white',
      maxHeight: '90%'
    }
  });
  mapPanel.add(controlPanel);
  
  // Add return button
  var backButton = ui.Button({
    label: 'Home',
    onClick: createHomePage,
    style: {
      padding: '8px',
      margin: '0 0 10px 0'
    }
  });
  controlPanel.add(backButton);
  
  // Load regional comparison module
  var module3Panel = createModule3();
  controlPanel.add(module3Panel);
}


// Add London coordinates
var LONDON_CENTER = ee.Geometry.Point([0.1278, 51.5074]);


// Regional comparison module
function createModule3() {
  var panel = ui.Panel({layout: ui.Panel.Layout.flow('vertical'), style: {width: '340px'}});
  
  // Data storage
  var savedCompareGeometries = [];
  var areaResults = {};  // Store area analysis results
  
  // Panel components
  var compareChartPanel = ui.Panel();
  var compareInfoPanel = ui.Panel();
  
  // Clear map and zoom to London
  mapPanel.layers().reset(); 
  mapPanel.centerObject(LONDON_CENTER, 9);
  
  // Add UK base map suitable for planting
  var ukSuitableMask = computeBasicSuitability(UK_boundary.geometry(), '2023');
  var ukLayer = mapPanel.addLayer(ukSuitableMask.selfMask(), 
                  {palette: ['#00FF00'], opacity: 0.4}, 
                  'UK Suitable Planting Areas');
  
  // Add initial panel content
  panel.add(ui.Label('Regional Comparison Analysis', {fontSize: '18px', fontWeight: 'bold', margin: '0 0 8px'}));
  panel.add(ui.Label('1. Area Trend', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(compareChartPanel);
  panel.add(ui.Label('2. Area Statistics', {fontWeight: 'bold', margin: '10px 0 4px'}));
  panel.add(compareInfoPanel);
  
  // Configure drawing tools
  var drawingTools = mapPanel.drawingTools();
  drawingTools.setLinked(false);
  drawingTools.setDrawModes(['rectangle', 'polygon']);
  drawingTools.setShown(false);
  
  // Add button to start drawing
  var startDrawingButton = ui.Button('Start Drawing Region', function() {
    drawingTools.layers().reset();
    drawingTools.setShown(true);
    drawingTools.setDrawModes(['polygon']);
    drawingTools.setShape('polygon');
    drawingTools.draw();
    
    showLoading("Please draw a region on the map");
    ee.Number(1).evaluate(function() {
      hideLoading();
    });
  });
  
  var saveButton = ui.Button('Save Region', function() {
    var drawn = drawingTools.layers().get(0);
    if (!drawn) {
      showLoading("Please draw a region first");
      ee.Number(1).evaluate(function() {
        hideLoading();
      });
      return;
    }
    var geom = drawn.toGeometry();
    var regionIndex = savedCompareGeometries.length + 1;
    savedCompareGeometries.push(geom);
    mapPanel.addLayer(geom, {color: 'blue'}, 'Comparison Region ' + regionIndex);
    drawingTools.layers().reset();
    drawingTools.setShown(false);
    
    showLoading("Region saved, please click 'Analyze Selected Region' button to analyze");
    ee.Number(1).evaluate(function() {
      hideLoading();
    });
  });
  
  var analyzeButton = ui.Button('Analyze Selected Region', function() {
    if (savedCompareGeometries.length === 0) {
      showLoading("Please draw and save a region first");
      ee.Number(1).evaluate(function() {
        hideLoading();
      });
      return;
    }
    
    // Get most recently saved region
    var regionIndex = savedCompareGeometries.length;
    var region = savedCompareGeometries[regionIndex - 1];
    
    showLoading("Analyzing region " + regionIndex + "...");
    
    // Analyze suitability change of the region (2020-2023)
    var years = [2020, 2021, 2022, 2023];
    var yearResults = {};
    var totalYears = years.length;
    var processedYears = 0;
    
    // Analyze basic suitability for each year
    years.forEach(function(year) {
      // Use simple filtering conditions to calculate suitability area
      var suitableMask = computeBasicSuitability(region, String(year));
      
      // Calculate suitable area size
      suitableMask.multiply(ee.Image.pixelArea()).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: region,
        scale: 250,
        maxPixels: 1e10
      }).evaluate(function(result) {
        var area = result ? result.mask / 1e6 : 0;
        
        yearResults[year] = {
          suitable_area: area
        };
        
        processedYears++;
        
        // If it's 2023, calculate the machine learning predicted high suitability area
        if (year === 2023) {
          // Get complete analysis results
          var mlResults = GrapeML.analyzeSuitability(region, String(year));
          
          // Display high suitability area (machine learning calculation)
          if (mlResults.mlResults && mlResults.mlResults.success) {
            // Extract high suitability area center point
            var highSuitPoints = mlResults.mlResults.highSuitabilityAreas
              .selfMask()
              .reduceToVectors({
                geometry: region,
                scale: 250,
                geometryType: 'centroid',
                maxPixels: 1e10
              });
            
            // Add high suitability area to map, using bright pink points
            mapPanel.addLayer(highSuitPoints, {
              color: '#FF1493',  // Deep pink
              pointSize: 6,      // Larger point size
              pointShape: 'circle' // Circular point
            }, 'Region ' + regionIndex + ' - High Suitability Points (>70%)');
            
            // Calculate high suitability area size
            mlResults.mlResults.highSuitabilityAreas.multiply(ee.Image.pixelArea()).reduceRegion({
              reducer: ee.Reducer.sum(),
              geometry: region,
              scale: 250,
              maxPixels: 1e10
            }).evaluate(function(highResult) {
              var highArea = highResult ? highResult.classification / 1e6 : 0;
              yearResults[year].high_suitable_area = highArea;
              
              finishProcessing();
            });
          } else {
            yearResults[year].high_suitable_area = 0;
            finishProcessing();
          }
        }
        
        // If all years are processed
        if (processedYears === totalYears) {
          finishProcessing();
        }
      });
      
      // Add suitable area layer for the year (only add the latest year to avoid too many layers)
      if (year === 2023) {
        mapPanel.addLayer(suitableMask.selfMask(), 
                       {palette: ['#00FF00'], opacity: 0.6}, 
                       'Region ' + regionIndex + ' - Suitable Area 2023');
      }
    });
    
    // Add vineyard distribution
    mapPanel.addLayer(vineyards.filterBounds(region), 
                     {color: 'purple', width: 1}, 
                     'Region ' + regionIndex + ' - Vineyard');
    
    // Execute after processing is complete
    function finishProcessing() {
      // Check if all data is ready
      var allReady = true;
      for (var i = 0; i < years.length; i++) {
        var year = years[i];
        if (!yearResults[year] || 
            (year === 2023 && yearResults[year].high_suitable_area === undefined)) {
          allReady = false;
          break;
        }
      }
      
      if (!allReady) return;
      
      // All data is ready, store results and display chart
      areaResults['region' + regionIndex] = yearResults;
      
      // Create trend chart
      var chartPanel = ui.Panel({
        layout: ui.Panel.Layout.flow('vertical'),
        style: {width: '100%', padding: '8px'}
      });
      
      // Add title
      chartPanel.add(ui.Label('Region ' + regionIndex + ' Suitability Trend', {
        fontWeight: 'bold',
        textAlign: 'center',
        margin: '0 0 8px 0'
      }));
      
      // Create chart data
      var chartData = [];
      years.forEach(function(year) {
        chartData.push(ee.Feature(null, {
          year: year,
          suitable_km2: yearResults[year].suitable_area
        }));
      });
      
      // Create chart
      var chart = ui.Chart.feature.byFeature(ee.FeatureCollection(chartData), 'year', ['suitable_km2'])
        .setChartType('LineChart')
        .setOptions({
          title: 'Suitable Area Change',
          hAxis: {title: 'Year'},
          vAxis: {title: 'Area (km²)'},
          lineWidth: 2,
          pointSize: 4,
          series: {0: {color: '#228B22'}},
          legend: {position: 'none'}
        });
      
      chartPanel.add(chart);
      
      // Add area information, highlighting high suitability area information
      var infoPanel = ui.Panel({
        layout: ui.Panel.Layout.flow('vertical'),
        style: {width: '100%', padding: '8px', margin: '8px 0', border: '1px solid #ddd'}
      });
      
      infoPanel.add(ui.Label('2023 Statistics:', {fontWeight: 'bold', margin: '0 0 4px 0'}));
      infoPanel.add(ui.Label('Suitable Planting Area: ' + yearResults[2023].suitable_area.toFixed(2) + ' km²'));
      
      // Make high suitability area information more prominent
      var highSuitLabel = ui.Label('High Suitability Area (>70%): ' + yearResults[2023].high_suitable_area.toFixed(2) + ' km²', {
        color: '#D81B60',  // Pink
        fontWeight: 'bold',
        padding: '4px',
        margin: '4px 0'
      });
      infoPanel.add(highSuitLabel);
      
      chartPanel.add(infoPanel);
      
      // If this is the first region, clear and add to main panel
      if (regionIndex === 1) {
        compareChartPanel.clear();
        compareInfoPanel.clear();
        compareChartPanel.add(chartPanel);
      } else {
        // If this is the second region, we need to ensure only one chart for this region exists
        // First, determine how many widgets are in the panel
        var widgetCount = 0;
        compareChartPanel.widgets().forEach(function() {
          widgetCount++;
        });
        
        // If there's already a chart for the first region, remove any additional charts
        if (widgetCount >= 1) {
          while (widgetCount > 1) {
            compareChartPanel.remove(compareChartPanel.widgets().get(widgetCount - 1));
            widgetCount--;
          }
        }
        
        // Now add the new chart for the second region
        compareChartPanel.add(chartPanel);
        
        // If there are two regions, enable comparison button
        compareButton.setDisabled(false);
      }
      
      hideLoading();
      
      showLoading("Region " + regionIndex + " analysis complete!");
      ee.Number(2).evaluate(function() {
        hideLoading();
      });
    }
  });
  
  var clearButton = ui.Button('Clear', function() {
    if (drawingTools.layers().length() > 0) {
      drawingTools.layers().reset();
      drawingTools.setShown(false);
    } else if (savedCompareGeometries.length > 0) {
      // Reset map
      mapPanel.layers().reset();
      
      // Re-add UK base map
      ukLayer = mapPanel.addLayer(ukSuitableMask.selfMask(), 
                      {palette: ['#00FF00'], opacity: 0.4}, 
                      'UK Suitable Planting Areas');
      
      // Remove the last geometry and analysis results
      savedCompareGeometries.pop();
      if (savedCompareGeometries.length >= 1) {
        var lastRegionIndex = savedCompareGeometries.length;
        delete areaResults['region' + (lastRegionIndex + 1)];
        
        // Re-add retained geometries
        for (var i = 0; i < savedCompareGeometries.length; i++) {
          var regionIdx = i + 1;
          mapPanel.addLayer(savedCompareGeometries[i], {color: 'blue'}, 'Comparison Region ' + regionIdx);
          
          // If there's analysis data for this region, re-display the layer
          if (areaResults['region' + regionIdx]) {
            // Add 2023 suitable area
            var region = savedCompareGeometries[i];
            var suitableMask = computeBasicSuitability(region, '2023');
            mapPanel.addLayer(suitableMask.selfMask(), 
                           {palette: ['#00FF00'], opacity: 0.6}, 
                           'Region ' + regionIdx + ' - Suitable Area 2023');
            
            // Add high suitability area (if any) - using pink points
            var mlResults = GrapeML.analyzeSuitability(region, '2023');
            if (mlResults.mlResults && mlResults.mlResults.success) {
              var highSuitPoints = mlResults.mlResults.highSuitabilityAreas
                .selfMask()
                .reduceToVectors({
                  geometry: region,
                  scale: 250,
                  geometryType: 'centroid',
                  maxPixels: 1e10
                });
              
              mapPanel.addLayer(highSuitPoints, {
                color: '#FF1493',  // Deep pink
                pointSize: 6,      // Larger point size
                pointShape: 'circle' // Circular point
              }, 'Region ' + regionIdx + ' - High Suitability Points (>70%)');
            }
            
            // Add vineyards
            mapPanel.addLayer(vineyards.filterBounds(region), 
                           {color: 'purple', width: 1}, 
                           'Region ' + regionIdx + ' - Vineyard');
          }
        }
      }
    }
    
    // Update UI
    updateUI();
  });
  
  var compareButton = ui.Button({
    label: 'Compare Two Regions',
    onClick: function() {
      if (Object.keys(areaResults).length < 2) {
        showLoading("Please analyze at least two regions before comparing");
        ee.Number(1).evaluate(function() {
          hideLoading();
        });
        return;
      }
      
      showLoading("Comparing region data...");
      
      compareInfoPanel.clear();
      
      // Get results of the last two regions
      var region1Results = areaResults['region' + (savedCompareGeometries.length - 1)];
      var region2Results = areaResults['region' + savedCompareGeometries.length];
      
      if (!region1Results || !region2Results) {
        hideLoading();
        showLoading("Unable to retrieve region data, please re-analyze");
        ee.Number(1).evaluate(function() {
          hideLoading();
        });
        return;
      }
      
      // Create comparison panel
      var comparisonPanel = ui.Panel({
        layout: ui.Panel.Layout.flow('vertical'),
        style: {width: '100%', padding: '8px', border: '1px solid #ddd'}
      });
      
      comparisonPanel.add(ui.Label('Region Comparison (2023)', {
        fontWeight: 'bold',
        textAlign: 'center',
        margin: '0 0 8px 0'
      }));
      
      // Create comparison table
      var table = ui.Panel({
        layout: ui.Panel.Layout.flow('vertical'),
        style: {width: '100%'}
      });
      
      // Add header
      var headerRow = ui.Panel({
        layout: ui.Panel.Layout.flow('horizontal'),
        style: {width: '100%', margin: '2px 0', padding: '4px', backgroundColor: '#f5f5f5'}
      });
      headerRow.add(ui.Label('Indicator', {width: '120px', fontWeight: 'bold'}));
      headerRow.add(ui.Label('Region ' + (savedCompareGeometries.length - 1), {width: '100px', fontWeight: 'bold'}));
      headerRow.add(ui.Label('Region ' + savedCompareGeometries.length, {width: '100px', fontWeight: 'bold'}));
      table.add(headerRow);
      
      // Add suitable area row
      var suitableRow = ui.Panel({
        layout: ui.Panel.Layout.flow('horizontal'),
        style: {width: '100%', margin: '2px 0', padding: '4px'}
      });
      suitableRow.add(ui.Label('Suitable Area (km²)', {width: '120px'}));
      suitableRow.add(ui.Label(region1Results[2023].suitable_area.toFixed(2), {width: '100px'}));
      suitableRow.add(ui.Label(region2Results[2023].suitable_area.toFixed(2), {width: '100px'}));
      table.add(suitableRow);
      
      // Add high suitability area row
      var highSuitableRow = ui.Panel({
        layout: ui.Panel.Layout.flow('horizontal'),
        style: {width: '100%', margin: '2px 0', padding: '4px'}
      });
      highSuitableRow.add(ui.Label('High Suitability Area (km²)', {width: '120px', color: '#D81B60', fontWeight: 'bold'}));
      highSuitableRow.add(ui.Label(region1Results[2023].high_suitable_area.toFixed(2), {width: '100px', color: '#D81B60'}));
      highSuitableRow.add(ui.Label(region2Results[2023].high_suitable_area.toFixed(2), {width: '100px', color: '#D81B60'}));
      table.add(highSuitableRow);
      
      // Add difference row
      var diffRow = ui.Panel({
        layout: ui.Panel.Layout.flow('horizontal'),
        style: {width: '100%', margin: '2px 0', padding: '4px', backgroundColor: '#f5f5f5'}
      });
      diffRow.add(ui.Label('Area Difference (km²)', {width: '120px', fontWeight: 'bold'}));
      
      var suitableDiff = region2Results[2023].suitable_area - region1Results[2023].suitable_area;
      var highSuitableDiff = region2Results[2023].high_suitable_area - region1Results[2023].high_suitable_area;
      
      diffRow.add(ui.Label(Math.abs(suitableDiff).toFixed(2) + 
                           (suitableDiff > 0 ? ' (Region ' + savedCompareGeometries.length + ' larger)' : ' (Region ' + (savedCompareGeometries.length-1) + ' larger)'), 
                           {width: '200px'}));
      table.add(diffRow);
      
      comparisonPanel.add(table);
      
      // Add conclusion panel
      var conclusionPanel = ui.Panel({
        layout: ui.Panel.Layout.flow('vertical'),
        style: {width: '100%', margin: '8px 0 0 0', padding: '8px', backgroundColor: '#f9f9f9'}
      });
      
      var conclusion = '';
      if (region1Results[2023].suitable_area > region2Results[2023].suitable_area) {
        conclusion = 'Region ' + (savedCompareGeometries.length - 1) + ' has a larger suitable planting area.\n';
      } else {
        conclusion = 'Region ' + savedCompareGeometries.length + ' has a larger suitable planting area.\n';
      }
      
      var highSuitConclusion = '';
      if (region1Results[2023].high_suitable_area > region2Results[2023].high_suitable_area) {
        highSuitConclusion = 'Region ' + (savedCompareGeometries.length - 1) + ' has a larger high suitability area,';
        highSuitConclusion += ' ' + Math.abs(highSuitableDiff).toFixed(2) + 'km² more than region ' + savedCompareGeometries.length;
      } else {
        highSuitConclusion = 'Region ' + savedCompareGeometries.length + ' has a larger high suitability area,';
        highSuitConclusion += ' ' + Math.abs(highSuitableDiff).toFixed(2) + 'km² more than region ' + (savedCompareGeometries.length - 1);
      }
      
      conclusionPanel.add(ui.Label('Conclusion:', {fontWeight: 'bold'}));
      conclusionPanel.add(ui.Label(conclusion));
      conclusionPanel.add(ui.Label(highSuitConclusion, {color: '#D81B60', fontWeight: 'bold'}));
      
      comparisonPanel.add(conclusionPanel);
      
      // Add to panel
      compareInfoPanel.add(comparisonPanel);
      
      hideLoading();
    },
    disabled: true,
    style: {margin: '5px 0'}
  });
  
  // Update UI state
  function updateUI() {
    // If at least two regions have been analyzed, enable comparison button
    compareButton.setDisabled(Object.keys(areaResults).length < 2);
    
    // If there are no regions, clear the chart and information panels
    if (savedCompareGeometries.length === 0) {
      compareChartPanel.clear();
      compareInfoPanel.clear();
    }
  }
  
  panel.add(ui.Label('3. Operations', {fontWeight: 'bold', margin: '10px 0 4px'}));
  
  // Add action buttons to panel
  var actionPanel1 = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {margin: '5px 0'}
  });
  actionPanel1.add(startDrawingButton);
  actionPanel1.add(saveButton);
  
  var actionPanel2 = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {margin: '5px 0'}
  });
  actionPanel2.add(analyzeButton);
  actionPanel2.add(clearButton);
  
  panel.add(actionPanel1);
  panel.add(actionPanel2);
  panel.add(compareButton);
  
  // Add usage instructions
  panel.add(ui.Label('Usage Instructions:', {fontWeight: 'bold', margin: '16px 0 4px'}));
  panel.add(ui.Label('1. Click "Start Drawing Region" to draw a region'));
  panel.add(ui.Label('2. Click "Save Region" to save the drawn shape'));
  panel.add(ui.Label('3. Click "Analyze Selected Region" to calculate'));
  panel.add(ui.Label('4. Repeat the above steps to add a second region'));
  panel.add(ui.Label('5. Click "Compare Two Regions" to view comparison'));
  
  // Add legend
  panel.add(ui.Label('Legend:', {fontWeight: 'bold', margin: '16px 0 4px'}));
  var legendPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      padding: '8px',
      margin: '0 0 8px 0',
      backgroundColor: 'white'
    }
  });
  
  legendPanel.add(createLegendRow('#00FF00', 'Suitable Planting Areas'));
  legendPanel.add(createLegendRow('#FF1493', 'High Suitability Points (>70%)'));
  legendPanel.add(createLegendRow('purple', 'Existing Vineyards (2023)'));
  
  panel.add(legendPanel);
  
  return panel;
}


// Climate Impact Analysis Tool Module - Changed to Display Filter Conditions Table
function createModule4() {
  var panel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'), 
    style: {width: '340px'}
  });
  
  // Add title
  panel.add(ui.Label('Grape Cultivation Suitability Evaluation Conditions', {
    fontSize: '18px', 
    fontWeight: 'bold', 
    margin: '0 0 12px'
  }));
  
  // Add explanatory text
  panel.add(ui.Label('The table below shows the key environmental factors used to assess grape cultivation suitability and their ideal range values. These conditions are based on the best environmental requirements for grape growth.', {
    margin: '0 0 12px'
  }));
  
  // Create table panel
  var tablePanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      width: '100%',
      margin: '8px 0',
      padding: '8px',
      border: '1px solid #ddd',
      backgroundColor: 'white'
    }
  });
  
  // Add header
  var headerRow = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {
      width: '100%',
      backgroundColor: '#f5f5f5',
      padding: '6px 0',
      margin: '0 0 4px 0',
      fontWeight: 'bold'
    }
  });
  
  headerRow.add(ui.Label('Environmental Factor', {width: '40%', textAlign: 'center', fontWeight: 'bold'}));
  headerRow.add(ui.Label('Ideal Range', {width: '35%', textAlign: 'center', fontWeight: 'bold'}));
  headerRow.add(ui.Label('Unit', {width: '25%', textAlign: 'center', fontWeight: 'bold'}));
  
  tablePanel.add(headerRow);
  
  // Add data rows
  function addTableRow(factor, range, unit, highlight) {
    var rowStyle = {
      width: '100%',
      padding: '6px 0',
      margin: '2px 0',
      backgroundColor: highlight ? '#f0f8ff' : 'white',
      border: '1px solid #eee'
    };
    
    var row = ui.Panel({
      layout: ui.Panel.Layout.flow('horizontal'),
      style: rowStyle
    });
    
    row.add(ui.Label(factor, {width: '40%', textAlign: 'left', padding: '0 0 0 8px'}));
    row.add(ui.Label(range, {width: '35%', textAlign: 'center'}));
    row.add(ui.Label(unit, {width: '25%', textAlign: 'center'}));
    
    tablePanel.add(row);
  }
  
  // Add actual data rows
  addTableRow('Growing Season Temperature (GST)', '14.0 - 16.0', '°C', true);
  addTableRow('Growing Degree Days (GDD)', '950 - 1250', 'GDD', false);
  addTableRow('Growing Season Precipitation (GSP)', '250 - 600', 'mm', true);
  addTableRow('Slope', '2 - 15', 'degrees', false);
  addTableRow('Elevation', '5 - 250', 'meters', true);
  
  // Add table to main panel
  panel.add(tablePanel);
  
  // Add notes and explanations
  panel.add(ui.Label('Notes:', {fontWeight: 'bold', margin: '12px 0 4px'}));
  
  var notesPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      padding: '8px',
      backgroundColor: '#f9f9f9',
      margin: '4px 0 8px 0'
    }
  });
  
  notesPanel.add(ui.Label('• GST: Average temperature during the growing season, which has a key impact on grape ripeness'));
  notesPanel.add(ui.Label('• GDD: Growing degree days, representing heat accumulation, which affects grape quality'));
  notesPanel.add(ui.Label('• GSP: Total precipitation during the growing season, which affects soil moisture and disease risk'));
  notesPanel.add(ui.Label('• Slope: Affects both drainage and sunlight exposure'));
  notesPanel.add(ui.Label('• Elevation: Affects temperature changes and microclimate'));
  
  panel.add(notesPanel);
  
  // Add information panel explaining the importance of these conditions
  panel.add(ui.Label('The importance of these conditions combined:', {fontWeight: 'bold', margin: '12px 0 4px'}));
  
  var infoPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      padding: '8px',
      backgroundColor: '#f0f8ff',
      margin: '4px 0'
    }
  });
  
  infoPanel.add(ui.Label('This system uses the above conditions to assess grape cultivation suitability. Regions meeting all conditions are marked as "suitable areas", with the region with the highest potential for high-quality grape production marked as "high suitability areas".'));
  
  panel.add(infoPanel);
  
  // Add code reference panel
  panel.add(ui.Label('Filter Conditions Code Used:', {fontWeight: 'bold', margin: '12px 0 4px'}));
  
  var codePanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      padding: '8px',
      backgroundColor: '#f5f5f5',
      margin: '4px 0',
      fontFamily: 'monospace',
      fontSize: '12px'
    }
  });
  
  codePanel.add(ui.Label('computeSuitabilityMask: function(factors) {'));
  codePanel.add(ui.Label('  var gstMask = factors.gst.gte(14.0).and(factors.gst.lte(16.0));'));
  codePanel.add(ui.Label('  var gddMask = factors.gdd.gte(950).and(factors.gdd.lte(1250));'));
  codePanel.add(ui.Label('  var gspMask = factors.gsp.gte(250).and(factors.gsp.lte(600));'));
  codePanel.add(ui.Label('  var slopeMask = factors.slope.gte(2).and(factors.slope.lte(15));'));
  codePanel.add(ui.Label('  var elevationMask = factors.elevation.gte(5).and(factors.elevation.lte(250));'));
  codePanel.add(ui.Label('  return gstMask.and(gddMask).and(gspMask).and(slopeMask).and(elevationMask);'));
  codePanel.add(ui.Label('}'));
  
  panel.add(codePanel);
  
  return panel;
}



// Use simple conditions to calculate basic suitability (without machine learning)
function computeBasicSuitability(region, year) {
  // Get environmental factors
  var factors = GrapeML.computeEnvironmentalFactors(region, year);
  
  // Apply simple filtering conditions to calculate suitability
  var suitabilityMask = GrapeML.computeSuitabilityMask(factors);
  
  return suitabilityMask.rename('mask').clip(region);
}

function createChart(title, trend) {
  return ui.Chart.feature.byFeature(trend, 'year', ['suitable_km2', 'highsuit_km2', 'vineyard_km2'])
    .setChartType('LineChart')
    .setOptions({
      title: title,
      hAxis: {title: 'Year'},
      vAxis: {title: 'Area (km²)'},
      series: {
        0: {color: 'green', label: 'Suitable Areas'},
        1: {color: 'darkgreen', label: 'High Suitability Areas (>70%)'},
        2: {color: 'purple', label: 'Vineyards'}
      },
      lineWidth: 2,
      pointSize: 4,
      width: 320,
      height: 250,
      legend: {position: 'bottom'}
    });
}


// Load Kent region quickly, then load other regions in the background
function initializeRegions() {
  showLoading("Loading Kent region data...");
  
  // First find the index of Kent
  var kentIndex = -1;
  for (var i = 0; i < regionNamesRaw.length; i++) {
    if (regionNamesRaw[i] === 'Kent') {
      kentIndex = i;
      break;
    }
  }
  
  // If Kent is not found, use the first region
  if (kentIndex === -1) {
    kentIndex = 0;
    currentCountyName = regionNamesRaw[0];
  } else {
    currentCountyName = 'Kent';
  }
  
  // Load Kent region first
  var county = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', currentCountyName)).first();
  var geom = county.geometry();
  var checkYear = '2023';
  
  var mask = computeMask(geom, checkYear);
  
  // Asynchronously calculate Kent region area
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
      
      // Add Kent to suitable list
      if (hasArea) {
        suitableNames.push(currentCountyName);
      } else {
        unsuitableNames.push(currentCountyName);
        unsuitableGeomsList.push(geom);
      }
      
      // Temporary initial region list, only includes Kent
      finalRegionNames = suitableNames.slice();
      
      // Build UI to display Kent data
      hideLoading();
      rebuildMainPanel();
      
      // Start loading other regions in the background
      backgroundLoadingInProgress = true;
      continueLoadingRegions(0, kentIndex);
    });
}

function continueLoadingRegions(startIdx, skipIdx) {
  if (startIdx >= regionNamesRaw.length) {
    finalizeRegionLists();
    return;
  }
  
  if (startIdx === skipIdx) {
    continueLoadingRegions(startIdx + 1, skipIdx);
    return;
  }
  
  var name = regionNamesRaw[startIdx];
  var county = ukLevel2.filter(ee.Filter.eq('ADM2_NAME', name)).first();
  var geom = county.geometry();
  var checkYear = '2023';
  
  var savedCurrentCountyName = currentCountyName;
  currentCountyName = name; 
  
  var mask = computeMask(geom, checkYear);
  
  showBackgroundLoading("Loading region: " + (startIdx + 1) + "/" + regionNamesRaw.length);
  
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
      
      currentCountyName = savedCurrentCountyName;
      
      ee.Number(1).evaluate(function() {
        continueLoadingRegions(startIdx + 1, skipIdx);
      });
    });
}

// Load all regions
function finalizeRegionLists() {
  finalRegionNames = suitableNames.slice();
  if (unsuitableNames.length > 0) {
    finalRegionNames.push('Unsuitable for 3 Years');
  }
  
  backgroundLoadingInProgress = false;
  hideBackgroundLoading();
  
  var isViewingTable = controlPanel.widgets().length() > 0 && 
                        controlPanel.widgets().get(0).getValue && 
                        controlPanel.widgets().get(0).getValue() === 'County Table (Click to Select)';
  
  if (isViewingTable) {
    showCountyTable();
  }
}

// Rebuild main panel
function rebuildMainPanel() {
  controlPanel.clear();
  
  var backButton = ui.Button({
    label: 'Home',
    onClick: createHomePage,
    style: {
      padding: '8px',
      margin: '0 0 10px 0'
    }
  });
  controlPanel.add(backButton);

  if (backgroundLoadingInProgress) {
    showBackgroundLoading("Loading region data...");
  }

  controlPanel.add(ui.Label('1. Select Region (Enter Name or View Table)', {fontWeight: 'bold'}));

  var viewTableButton = ui.Button({
    label: 'View Region Table',
    onClick: showCountyTable
  });
  controlPanel.add(viewTableButton);

  var inputPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%'}
  });

  countyInput = ui.Textbox({
    placeholder: 'Enter Region Name...',
    value: currentCountyName,
    style: {width: '370px'},
    disabled: true
  });

  

  inputPanel.add(countyInput);
  controlPanel.add(inputPanel);

  controlPanel.add(ui.Label('2. Suitable Area (km²)', {fontWeight: 'bold'}));
  chartPanel = ui.Panel();
  controlPanel.add(chartPanel);

  controlPanel.add(ui.Label('3. View Mode', {fontWeight: 'bold'}));

  var buttonPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%', margin: '4px 0'}
  });

  var singleYearButton = ui.Button({
    label: 'Single Year View',
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
    label: 'Multi-Year Analysis',
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

  yearSlider = ui.Slider({
    min: 2010, max: 2023, value: 2023, step: 1,
    onChange: function() { 
      if (currentRegion) {
        showLoading("Updating year data...");
        ee.Number(1).evaluate(function() {
          updateYearlyMap(currentRegion, yearSlider.getValue());
          hideLoading();
        });
      }
    },
    style: {width: '350px'}
  });

  yearInputPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%', margin: '4px 0'}
  });

  var yearInputsContainer = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {width: '100%', margin: '0'}
  });

  var fromLabel = ui.Label('Start Year:', {margin: '4px 4px 0 0'});
  startYearInput = ui.Textbox({
    placeholder: '2021',
    style: {width: '80px', margin: '0 8px 0 0'}
  });

  var toLabel = ui.Label('End Year:', {margin: '4px 4px 0 0'});
  endYearInput = ui.Textbox({
    placeholder: '2023',
    style: {width: '80px'}
  });

  yearInputsContainer.add(fromLabel);
  yearInputsContainer.add(startYearInput);
  yearInputsContainer.add(toLabel);
  yearInputsContainer.add(endYearInput);
  yearInputPanel.add(yearInputsContainer);

  controlPanel.add(yearSlider);
  controlPanel.add(yearInputPanel);

  yearInputPanel.style().set('shown', false);

  var updateButton = ui.Button({
    label: 'Update Map',
    onClick: function() {
      if (!currentRegion) return;
      
      if (modeSelect === 'Single Year') {
        showLoading("Updating map...");
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
        showLoading("Analyzing multi-year data...");
        ee.Number(1).evaluate(function() {
          showPersistentSuitability(currentRegion, s, e);
          hideLoading();
        });
      }
    }
  });
  controlPanel.add(updateButton);

  controlPanel.add(ui.Label('4. Layer Control', {fontWeight: 'bold', margin: '12px 0 4px'}));

  var legendPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      padding: '8px',
      margin: '0 0 8px 0',
      backgroundColor: 'white'
    }
  });

  checkboxRegion = ui.Checkbox({
    label: '', 
    value: true, 
    onChange: function() {
      showLoading("Updating map...");
      ee.Number(1).evaluate(function() {
        updateRegion();
        hideLoading();
      });
    }
  });
  var regionRow = ui.Panel([checkboxRegion, createLegendRow('orange', 'Region Boundary')], 
    ui.Panel.Layout.flow('horizontal'));
  legendPanel.add(regionRow);

  checkboxSuitability = ui.Checkbox({
    label: '', 
    value: true, 
    onChange: function() {
      showLoading("Updating map...");
      ee.Number(1).evaluate(function() {
        updateRegion();
        hideLoading();
      });
    }
  });
  var suitabilityRow = ui.Panel([checkboxSuitability, createLegendRow('#00FF00', 'Suitable Planting Areas')],
    ui.Panel.Layout.flow('horizontal'));
  legendPanel.add(suitabilityRow);

  checkboxVineyards = ui.Checkbox({
    label: '', 
    value: true, 
    onChange: function() {
      showLoading("Updating map...");
      ee.Number(1).evaluate(function() {
        updateRegion();
        hideLoading();
      });
    }
  });
  var vineyardsRow = ui.Panel([checkboxVineyards, createLegendRow('purple', 'Existing Vineyards (2023)')],
    ui.Panel.Layout.flow('horizontal'));
  legendPanel.add(vineyardsRow);

  controlPanel.add(legendPanel);

  currentRegion = getRegionGeometry(currentCountyName);
  updateRegion();
}

function updateViewMode() {
  if (modeSelect === 'Single Year') {
    yearSlider.style().set('shown', true);
    yearInputPanel.style().set('shown', false);
  } else {
    yearSlider.style().set('shown', false);
    yearInputPanel.style().set('shown', true);
  }
}

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

  var years = ee.List.sequence(2010, 2023).getInfo();
  var batchSize = 4; 
  var features = [];
  
  showLoading("Building a time series chart...");
  processBatch(0);
  
  function processBatch(startIdx) {
    if (startIdx >= years.length) {
      finishChart();
      return;
    }
    
    var endIdx = Math.min(startIdx + batchSize, years.length);
    var batchYears = years.slice(startIdx, endIdx);
    
    showLoading("Building a time series chart... (" + endIdx + "/" + years.length + ")");
    
    var batchFeatures = batchYears.map(function(y) {
      var mask = computeMask(currentRegion, String(y));
      var area = computeArea(mask, currentRegion);
      return ee.Feature(null, {year: y, area_km2: ee.Number(area).divide(1e6)});
    });
    
    features = features.concat(batchFeatures);
    
    ee.Number(1).evaluate(function() {
      processBatch(endIdx);
    });
  }
  
  function finishChart() {
    var ts = ee.FeatureCollection(features);
    var chart = ui.Chart.feature.byFeature(ts, 'year', 'area_km2')
      .setChartType('LineChart')
      .setOptions({
        title: 'The suitable area for many years',
        hAxis: {title: 'year', format: '####'},
        vAxis: {title: 'area (km²)'},
        lineWidth: 2,
        pointSize: 5,
        height: 220,
        series: {0: {color: '#228B22'}},
        backgroundColor: {fill: 'white'},
        legend: {position: 'none'}
      });
    chartPanel.add(chart);
    
    if (checkboxSuitability.getValue()) {
      var m = computeMask(currentRegion, '2023');
      mapPanel.addLayer(m.selfMask(), {
        palette: ['#00FF00'],
        opacity: 0.7
      }, 'Suitability 2023');
    }
    
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

function showPersistentSuitability(region, startYear, endYear) {
  mapPanel.layers().reset();

  if (checkboxRegion.getValue()) {
    mapPanel.addLayer(region, {
      color: 'orange',
      fillColor: '00000000',
      width: 2
    }, 'Selected Region');
  }

  var totalYears = endYear - startYear + 1;
  var batchSize = 3; 
  var maskImages = [];
  
  processYearBatch(startYear);
  
  function processYearBatch(currentYear) {
    if (currentYear > endYear) {
      finalizePersistentMap();
      return;
    }
    
    var endYearBatch = Math.min(currentYear + batchSize - 1, endYear);
    showLoading("Processing year " + currentYear + " to " + endYearBatch + " (" + 
               (endYearBatch - startYear + 1) + "/" + totalYears + ")");
    
    for (var y = currentYear; y <= endYearBatch; y++) {
      maskImages.push(computeMask(region, String(y)));
    }
    
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

function showCountyTable() {
  controlPanel.clear();
  
  var backButton = ui.Button({
    label: 'Home',
    onClick: createHomePage,
    style: {
      padding: '8px',
      margin: '0 0 10px 0'
    }
  });
  controlPanel.add(backButton);
  
  controlPanel.add(ui.Label('Regional list (Click to select)', {fontWeight: 'bold'}));

  var grid = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'), 
    style: {width: '380px', height: '400px', padding: '8px'}
  });
  
  if (backgroundLoadingInProgress) {
    showBackgroundLoading("datasets downloading...");
  }
  
  showLoading("Loading area list...");
  
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
        label: 'no suitable area',
        onClick: function() {
          currentCountyName = 'Unsuitable for 3 Years';
          rebuildMainPanel();
        }
      });
      unsuitBtn.style().set('width', '380px');
      grid.add(unsuitBtn);
    }

    var closeButton = ui.Button({
      label: 'go back',
      onClick: rebuildMainPanel
    });
    grid.add(closeButton);

    controlPanel.add(grid);
    hideLoading();
  });
}

// =========== Part 5: Start Application ===========

// Start main page
createHomePage();