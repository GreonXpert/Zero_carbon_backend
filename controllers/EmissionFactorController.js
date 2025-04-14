const EmissionFactor = require('../models/EmissionFactor');

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