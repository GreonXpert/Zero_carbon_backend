const express = require('express');
const { saveFlowchart, getFlowchart,getFlowchartUser,updateFlowchartUser,updateFlowchartAdmin ,deleteFlowchartUser,deleteFlowchartAdmin} = require('../controllers/flowchartController');
const { authenticate } = require('../utils/authenticate');

const router = express.Router();

router.get('/user/get',authenticate,getFlowchartUser);
router.delete('/user/delete',authenticate,deleteFlowchartUser);
router.delete('/admin/delete',deleteFlowchartAdmin); 
router.patch('/user/update',authenticate,updateFlowchartUser);
router.patch('/admin/update',updateFlowchartAdmin);
router.get('/get/:userId', getFlowchart); 
router.post('/save', saveFlowchart);

module.exports = router;
 