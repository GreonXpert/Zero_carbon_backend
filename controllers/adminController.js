const Form = require("../models/Form");

const getForm = async (req, res, next) => {
  try {
    const forms = await Form.find().sort({ createdAt: -1 });
    res.status(200).json(forms);
  } catch (error) {
    res.status(500).json({ message: "Error fetching forms", error });
  }
};

const getFormById = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.id);
    if (!form) {
      return res.status(404).json({ message: "Form not found" });
    }

    form.isRead = true;
    await form.save();

    res
      .status(200)
      .json({ message: "Form details fetched successfully", form });
  } catch (error) {
    console.error("Error fetching form details:", error);
    res.status(500).json({ message: "Error fetching form details", error });
  }
};

const getFormByFilter = async (req, res, next) => {
  try {
    const { companyName, status} = req.query;

    const filters = {};

    if (companyName)
      filters.companyName = { $regex: companyName, $options: "i" };
    if (status)
      filters.status = { $regex: status, $options: "i" };    
    const forms = await Form.find(filters).sort({ createdAt: -1 });
    res.status(200).json(forms);
  } catch (err) {
    res.status(500).json({ error: "Error fetching forms" });
  }
};

const getDashboardMatrics = async (req, res, next) => {
  try {
    const totalSubmissions = await Form.countDocuments();
    const pendingActions = await Form.countDocuments({ isRead: false });

    const submissionBreakdown = await Form.aggregate([
      {
        $group: {
          _id: "$industrySector",
          count: { $sum: 1 },
        },
      },
    ]);

    const recentActivity = await Form.find()
      .sort({ updatedAt: -1 })
      .limit(5)
      .select("companyName industrySector updatedAt");

    console.log(
      "pendingActions:",
      pendingActions,
      "submissionBreakdown:",
      submissionBreakdown,
      "recentActivity:",
      recentActivity
    );

    res.status(200).json({
      totalSubmissions,
      pendingActions,
      submissionBreakdown,
      recentActivity,
    });
  } catch (error) {
    console.error("Error fetching form details:", error);
    res
      .status(500)
      .json({
        error: "Error fetching dashboard metrics",
        details: error.message,
      });
  }
};

const leadsStatus = async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;
  console.log("status:", status);
  console.log("id:", id);
  try {
    const updatedForm = await Form.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );
    if (!updatedForm) return res.status(404).json({ error: "Form not found" });
    console.log("status submitted");
    res.json(updatedForm);
  } catch (error) {
    res.status(500).json({ error: "Error updating form status" });
  }
};

module.exports = {
  getFormByFilter,
  getForm,
  getFormById,
  getDashboardMatrics,
  leadsStatus,
};
