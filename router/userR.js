const express=require("express");
const {formSubmission,getUsersWithUserTypeUser}=require("../controllers/userController");
const auth = require("../middleware/auth");
const router=express.Router();


// Protected routes (require valid JWT token)
router.post("/forms", auth, formSubmission);
router.get("/getuser", auth, getUsersWithUserTypeUser);




module.exports=router;