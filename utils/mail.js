const nodemailer=require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  auth: {
    user:"anusreee2912@gmail.com",
    pass:"vsqpsjbxflxwlenj"

  },
});

 const sendMail = async (receiver, subject, message) => {
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: receiver,
      subject: subject,
      text: message,
    });
    console.log("Email send successfully", info);
    return true;
  } catch (err) {
    console.log("Error sending email", err);
    return false;
  }
 
};



 const randomPassGen=(length)=>{
      const characters="idnhb4j5n3mvbaj285nbhskcnah475nvbghadfiekmba75001nvgr";
      let result='';
      const charLength=characters.length;
      for(let i=0;i<length;i++){
        result+=characters.charAt(Math.floor(Math.random()*charLength));
      }
      return result;
}

module.exports={sendMail,randomPassGen}