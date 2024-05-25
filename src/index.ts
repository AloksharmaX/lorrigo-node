import express from "express";
// import * as dotenv from "dotenv";
import type { Request, Response } from "express";
import authRouter from "./routes/auth.routes";
import mongoose from "mongoose";
const app = express();
import config from "./utils/config";
import orderRouter from "./routes/order.routes";
import { AuthMiddleware, ErrorHandler } from "./utils/middleware";
import { addVendors, getSellers, ratecalculatorController, updateVendor4Seller } from "./utils/helpers";
import hubRouter from "./routes/hub.routes";
import cors from "cors";
import customerRouter from "./routes/customer.routes";
import morgan from "morgan";
import shipmentRouter from "./routes/shipment.routes";
import sellerRouter from "./routes/seller.routes";
import runCron, { CONNECT_SHIPROCKET, CONNECT_SMARTR, CONNECT_SMARTSHIP, calculateRemittanceEveryDay } from "./utils/cronjobs";
import Logger from "./utils/logger";
import adminRouter from "./routes/admin.routes";
import PincodeModel from "./models/pincode.model";
import HubModel from "./models/hub.model";
import SellerModel from "./models/seller.model";
import { getSpecificOrder } from "./controllers/order.controller";

app.use(cors({ origin: "*" }));

app.use(express.json());

//@ts-ignore
morgan.token("reqbody", (req, res) => JSON.stringify(req.body));
app.use(morgan(":method :url :status - :response-time ms - :reqbody"));

app.get("/ping", (_req, res: Response) => {
  return res.send("pong");
});

if (!config.MONGODB_URI) {
  Logger.log("MONGODB_URI doesn't exists: " + config.MONGODB_URI);
  process.exit(0);
}

// async function toUpdatePinDB() {
//   const updateQuery = {
//     $set: {
//       District: "Delhi"
//     }
//   }
//   const update = await PincodeModel.updateMany({ StateName: "Delhi" }, updateQuery);

// }

// async function toUpdatePrimaryHubDB() {
//   const updateQuery = {
//     $set: {
//       isPrimary: true
//     }
//   }
//   const allSeller = await SellerModel.find();


//   for (let i = 0; i < allSeller.length; i++) {
//     const update = await HubModel.updateOne({ sellerId: allSeller[i]._id.toString() }, updateQuery);
//   }
// }




mongoose
  .connect(config.MONGODB_URI)
  .then(() => {
    Logger.plog(" db connected successfully");
    CONNECT_SHIPROCKET();
    CONNECT_SMARTSHIP();
    CONNECT_SMARTR();
    calculateRemittanceEveryDay()
  })
  .catch((err) => {
    Logger.log(err.message);
  });

app.use("/api/auth", authRouter);
app.post("/api/vendor", addVendors);
app.get("/api/getsellers", getSellers);    //admin

// @ts-ignore
app.get("/api/order/:id", getSpecificOrder);

app.post("/api/shopify", (req, res) => {
  console.log(req.body);
  return res.send("ok");
});

//@ts-ignore
app.post("/api/ratecalculator", AuthMiddleware, ratecalculatorController);
//@ts-ignore
app.use("/api/seller", AuthMiddleware, sellerRouter);
//@ts-ignore
app.use("/api/customer", AuthMiddleware, customerRouter);
//@ts-ignore
app.use("/api/hub", AuthMiddleware, hubRouter);
//@ts-ignore
app.use("/api/order", AuthMiddleware, orderRouter);
//@ts-ignore
app.use("/api/shipment", AuthMiddleware, shipmentRouter);
//@ts-ignore
app.use("/api/admin", adminRouter);

app.use(ErrorHandler);
app.use("*", (req: Request, res: Response) => {
  return res.status(404).send({
    valid: false,
    message: "invalid route",
  });
});

runCron();

app.listen(config.PORT, () => Logger.plog("server running on port " + config.PORT));
