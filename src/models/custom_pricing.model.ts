import mongoose from "mongoose";

const pricingSchema = {
  basePrice: { type: Number, required: true, min: 0 },
  incrementPrice: { type: Number, required: true, min: 0 },
};
const codSchema = {
  hard: { type: Number, required: true, min: 0 },
  percent: { type: Number, required: true, min: 0 },
}
const CustomPricingSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Courier" },
    codCharge: { type: codSchema, required: true },
    withinCity: { type: pricingSchema, required: true },
    withinZone: { type: pricingSchema, required: true },
    withinMetro: { type: pricingSchema, required: true },
    withinRoi: { type: pricingSchema, required: true },
    northEast: { type: pricingSchema, required: true },
  },
  { timestamps: true }
);

const CustomPricingModel = mongoose.model("CustomPricing", CustomPricingSchema);
export default CustomPricingModel;
