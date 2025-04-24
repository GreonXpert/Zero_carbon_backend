const express=require("express");
const {formSubmission,getUsersWithUserTypeUser, getUsersByCompanyName}=require("../controllers/userController");
const auth = require("../middleware/auth");
const router=express.Router();


// Protected routes (require valid JWT token)
router.post("/forms", auth, formSubmission);
router.get("/getuser", auth, getUsersWithUserTypeUser);
router.get("/getuserbyCompanyName/:companyName",   getUsersByCompanyName);




module.exports=router;