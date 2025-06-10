const express=require("express");
const {registerUser,login,updateUser,deleteUser}=require("../controllers/userController");
const {forgotPassword}=require("../controllers/forgotpassword");
const { auth } = require("../middleware/auth");
const router=express.Router();

// router.post('/register',registerUser);
router.post('/login',login);
router.put('/user/:id',auth, updateUser);
// router.delete('/user/:id',auth,deleteUser);
router.post('/forgotpassword',forgotPassword);

module.exports=router;