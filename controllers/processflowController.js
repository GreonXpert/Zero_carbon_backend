// controllers/processflowController.js
const ProcessFlowchart = require('../models/ProcessFlowchart');
const mongoose = require('mongoose');

exports.saveProcessFlowchart = async (req, res) => {
  const { userId, flowchartData } = req.body;
  if (!userId || !flowchartData || !flowchartData.nodes || !flowchartData.edges) {
    return res.status(400).json({ message: "Missing required fields" });
  }
  try {
    const existing = await ProcessFlowchart.findOne({ userId });
    if (existing) {
      existing.nodes = flowchartData.nodes;
      existing.edges = flowchartData.edges;
      await existing.save();
      return res.status(200).json({ message: "Process flowchart updated" });
    }
    const newChart = new ProcessFlowchart({ userId, ...flowchartData });
    await newChart.save();
    res.status(200).json({ message: "Process flowchart saved" });
  } catch (err) {
    console.error("Error saving process flowchart:", err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getProcessFlowchart = async (req, res) => {
  try {
    const { userId } = req.params;
    const chart = await ProcessFlowchart.findOne({ userId });
    if (!chart) return res.status(404).json({ message: "No process flowchart found" });
    res.status(200).json(chart);
  } catch (err) {
    res.status(500).json({ message: "Error fetching process flowchart" });
  }
};

exports.updateProcessFlowchart = async (req, res) => {
  try {
    const { userId, nodes, edges } = req.body;
    const chart = await ProcessFlowchart.findOne({ userId });
    if (!chart) return res.status(404).json({ message: "Chart not found" });
    chart.nodes = nodes;
    chart.edges = edges;
    await chart.save();
    res.status(200).json({ message: "Process flowchart updated" });
  } catch (err) {
    res.status(500).json({ message: "Update failed" });
  }
};

exports.deleteProcessNode = async (req, res) => {
  try {
    const { userId, nodeId } = req.body;
    const chart = await ProcessFlowchart.findOne({ userId });
    if (!chart) return res.status(404).json({ message: "Chart not found" });
    chart.nodes = chart.nodes.filter(n => n.id !== nodeId);
    chart.edges = chart.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
    await chart.save();
    res.status(200).json({ message: "Node and edges deleted" });
  } catch (err) {
    res.status(500).json({ message: "Delete failed" });
  }
};
