const EmissionFactor = require('../models/EmissionFactor');
 const csvtojson = require('csvtojson');

// Create a new category
exports.createCategory = async (req, res) => {
  try {
    const category = new EmissionFactor(req.body);
    await category.save();
    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get all categories
exports.getCategories = async (req, res) => {
  try {
    const categories = await EmissionFactor.find();
    res.status(200).json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Add a new activity to a category
exports.addActivity = async (req, res) => {
  try {
    const { categoryId, activity } = req.body;
    const category = await EmissionFactor.findById(categoryId);
    category.activities.push(activity);
    await category.save();
    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// // Add a new fuel to an activity
// exports.addFuel = async (req, res) => {
//   try {
//     const { categoryId, activityId, fuel } = req.body;
//     const category = await EmissionFactor.findById(categoryId);
//     const activity = category.activities.id(activityId);
//     activity.fuels.push(fuel);
//     await category.save();
//     res.status(201).json(category);
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// };

// Get category by ID
exports.getCategoryById = async (req, res) => {
    try {
      const { categoryId } = req.params; // Extract categoryId from the request parameters
      const category = await EmissionFactor.findById(categoryId);
  
      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }
  
      res.status(200).json(category); // Respond with the found category
    } catch (error) {
      res.status(500).json({ error: error.message }); // Handle any server errors
    }
  };

// Update category by ID
exports.updateCategoryById = async (req, res) => {
    try {
      const { categoryId } = req.params; // Extract categoryId from the URL
      const updatedData = req.body; // Extract new data from the request body
  
      const updatedCategory = await EmissionFactor.findByIdAndUpdate(
        categoryId, // Find the category by ID
        updatedData, // Replace the existing data with the new data
        { new: true, runValidators: true } // Return the updated document and run validation
      );
  
      if (!updatedCategory) {
        return res.status(404).json({ message: 'Category not found' });
      }
  
      res.status(200).json(updatedCategory); // Respond with the updated category
    } catch (error) {
      res.status(500).json({ error: error.message }); // Handle any server errors
    }
  };

  // Delete category by ID
exports.deleteCategoryById = async (req, res) => {
    try {
      const { categoryId } = req.params; // Extract categoryId from the URL
  
      const deletedCategory = await EmissionFactor.findByIdAndDelete(categoryId); // Find and delete the category by ID
  
      if (!deletedCategory) {
        return res.status(404).json({ message: 'Category not found' });
      }
  
      res.status(200).json({ message: 'Category deleted successfully', deletedCategory });
    } catch (error) {
      res.status(500).json({ error: error.message }); // Handle any server errors
    }
  };


// Filter data by category name, activity name, or fuel name
// Filter data by category name, activity name, or fuel name
exports.filterData = async (req, res) => {
    try {
      const { categoryName, activityName, fuelName } = req.query;
  
      let query = {};
  
      // Base query for category name
      if (categoryName) {
        query.name = { $regex: new RegExp(categoryName, 'i') }; // Case-insensitive match
      }
  
      // Fetch data based on the base query
      let filteredData = await EmissionFactor.find(query);
  
      // Refine the results further for activities and fuels
      if (activityName || fuelName) {
        filteredData = filteredData.map((category) => { 
          // Filter activities within the category
          let activities = category.activities;
  
          if (activityName) {
            activities = activities.filter((activity) =>
              new RegExp(activityName, 'i').test(activity.name)
            );
          }
  
          if (fuelName) {
            activities = activities.map((activity) => {
              // Filter fuels within the activity
              const fuels = activity.fuels.filter((fuel) =>
                new RegExp(fuelName, 'i').test(fuel.name)
              );
              return { ...activity.toObject(), fuels };
            }).filter((activity) => activity.fuels.length > 0); // Remove activities without matching fuels
          }
  
          return { ...category.toObject(), activities };
        }).filter((category) => category.activities.length > 0); // Remove categories without matching activities
      }
  
      if (!filteredData.length) {
        return res.status(404).json({ message: 'No matching data found' });
      }
  
      res.status(200).json(filteredData);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

/**
 * Download all emission factors as a flattened CSV.
 */
exports.downloadCSV = async (req, res) => {
  try {
    // 1. Fetch everything
    const categories = await EmissionFactor.find();

    // 2. Flatten into one record per unit
    const records = [];
    categories.forEach(category => {
      category.activities.forEach(activity => {
        activity.fuels.forEach(fuel => {
          fuel.units.forEach(unit => {
            records.push({
              category: category.name,
              activity: activity.name,
              fuel: fuel.name,
              unitType: unit.type,
              kgCO2e: unit.kgCO2e,
              kgCO2: unit.kgCO2,
              kgCH4: unit.kgCH4,
              kgN2O: unit.kgN2O,
              reference: fuel.reference,
              source: fuel.source
            });
          });
        });
      });
    });

    // 3. Define CSV columns & build header row
    const fields = [
      'category',
      'activity',
      'fuel',
      'unitType',
      'kgCO2e',
      'kgCO2',
      'kgCH4',
      'kgN2O',
      'reference',
      'source'
    ];
    const header = fields.join(',');

    // 4. Build each data row, with proper quoting
    const rows = records.map(rec => {
      return fields.map(f => {
        const val = rec[f] == null ? '' : rec[f].toString();
        // escape any quotes in the field
        return `"${val.replace(/"/g, '""')}"`;
      }).join(',');
    });

    // 5. Combine into one CSV string
    const csv = [header, ...rows].join('\r\n');

    // 6. Stream it down
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="emission_factors.csv"');
    return res.send(csv);

  } catch (error) {
    console.error('CSV download error:', error);
    return res.status(500).json({ error: error.message });
  }
};

exports.bulkUpload = async (req, res) => {
  try {
    // 1. Get CSV text
    let csvText;
    if (req.file) {
      // if multipart/form-data upload
      csvText = req.file.buffer.toString('utf8');
    } else if (req.body.csv) {
      // if POST body has raw CSV
      csvText = req.body.csv;
    } else {
      return res.status(400).json({ error: 'No CSV provided. Attach as file or in body.csv' });
    }

    // 2. Parse CSV into flat array of objects
    //    Expect columns: category,activity,fuel,unitType,kgCO2e,kgCO2,kgCH4,kgN2O,reference,source
    const rows = await csvtojson().fromString(csvText);

    // 3. Re‐nest into { name, activities: [ { name, fuels: [ { name, reference, source, units: [...] } ] } ] }
    const byCategory = {};
    rows.forEach(r => {
      const {
        category, activity, fuel,
        unitType, kgCO2e, kgCO2, kgCH4, kgN2O,
        reference, source
      } = r;

      // ensure category
      if (!byCategory[category]) {
        byCategory[category] = {
          name: category,
          activities: {}
        };
      }
      const cat = byCategory[category];

      // ensure activity
      if (!cat.activities[activity]) {
        cat.activities[activity] = {
          name: activity,
          fuels: {}
        };
      }
      const act = cat.activities[activity];

      // ensure fuel
      if (!act.fuels[fuel]) {
        act.fuels[fuel] = {
          name: fuel,
          reference,
          source,
          units: []
        };
      }
      const f = act.fuels[fuel];

      // push unit
      f.units.push({
        type:  unitType,
        kgCO2e: parseFloat(kgCO2e) || 0,
        kgCO2:  parseFloat(kgCO2)  || 0,
        kgCH4:  parseFloat(kgCH4)  || 0,
        kgN2O:  parseFloat(kgN2O)  || 0
      });
    });

    // 4. Convert to array of docs
    const docs = Object.values(byCategory).map(cat => ({
      name: cat.name,
      activities: Object.values(cat.activities).map(act => ({
        name: act.name,
        fuels: Object.values(act.fuels)
      }))
    }));

    // 5. Save all at once
    const created = await EmissionFactor.insertMany(docs);

    res.status(201).json({
      message: `Imported ${created.length} categories`,
      created
    });

  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({ error: error.message });
  }
};