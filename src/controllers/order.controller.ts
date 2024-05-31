import { Response, NextFunction } from "express";
import type { ExtendedRequest } from "../utils/middleware";
import { B2COrderModel, B2BOrderModel } from "../models/order.model";
import ProductModel from "../models/product.model";
import HubModel from "../models/hub.model";
import { format, parse } from "date-fns";
import {
  getSellerChannelConfig,
  getShiprocketToken,
  isValidPayload,
  rateCalculation,
} from "../utils/helpers";
import { isValidObjectId } from "mongoose";
import type { ObjectId } from "mongoose";
import envConfig from "../utils/config";
import axios from "axios";
import APIs from "../utils/constants/third_party_apis";

import csvtojson from "csvtojson";
import exceljs from "exceljs";

import { DELIVERED, IN_TRANSIT, NDR, NEW, NEW_ORDER_DESCRIPTION, NEW_ORDER_STATUS, READY_TO_SHIP, RETURN_CANCELLATION, RETURN_CONFIRMED, RETURN_DELIVERED, RETURN_IN_TRANSIT, RETURN_PICKED, RTO } from "../utils/lorrigo-bucketing-info";
import { convertToISO, validateBulkOrderField } from "../utils";

// TODO create api to delete orders

export const createB2COrder = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    if (!body) return res.status(200).send({ valid: false, message: "Invalid payload" });

    const customerDetails = body?.customerDetails;
    const productDetails = body?.productDetails;

    if (
      !isValidPayload(body, [
        "order_reference_id",
        // "total_order_value",
        "payment_mode",
        "customerDetails",
        "productDetails",
        "pickupAddress",
      ])
    )
      return res.status(200).send({ valid: false, message: "Invalid payload" });

    if (!isValidPayload(productDetails, ["name", "category", "quantity", "taxRate", "taxableValue"]))
      return res.status(200).send({ valid: false, message: "Invalid payload: productDetails" });
    if (!isValidPayload(customerDetails, ["name", "phone", "address", "pincode"]))
      return res.status(200).send({ valid: false, message: "Invalid payload: customerDetails" });
    if (!isValidObjectId(body.pickupAddress))
      return res.status(200).send({ valid: false, message: "Invalid pickupAddress" });

    if (!(body.payment_mode === 0 || body.payment_mode === 1))
      return res.status(200).send({ valid: false, message: "Invalid payment mode" });
    if (body.payment_mode === 1) {
      if (!body?.amount2Collect) {
        return res.status(200).send({ valid: false, message: "amount2Collect > 0 for COD order" });
      }
    }
    if (body.total_order_value > 50000) {
      if (!isValidPayload(body, ["ewaybill"]))
        return res.status(200).send({ valid: false, message: "Ewaybill required." });
    }

    try {
      const orderWithOrderReferenceId = await B2COrderModel.findOne({
        sellerId: req.seller._id,
        order_reference_id: body?.order_reference_id,
      }).lean();

      if (orderWithOrderReferenceId) {
        const newError = new Error("Order reference Id already exists.");
        return next(newError);
      }
    } catch (err) {
      return next(err);
    }

    let hubDetails;
    try {
      hubDetails = await HubModel.findById(body?.pickupAddress);
      if (!hubDetails) return res.status(200).send({ valid: false, message: "Pickup address doesn't exists" });

    } catch (err) {
      return next(err);
    }


    let savedProduct;
    try {
      const { name, category, hsn_code, quantity, taxRate, taxableValue } = productDetails;
      const product2save = new ProductModel({
        name,
        category,
        hsn_code,
        quantity,
        tax_rate: taxRate,
        taxable_value: taxableValue,
      });
      savedProduct = await product2save.save();
    } catch (err) {
      return next(err);
    }
    const orderboxUnit = "kg";

    const orderboxSize = "cm";
    let savedOrder;
    const data = {
      sellerId: req.seller?._id,
      isReverseOrder: body?.isReverseOrder,
      bucket: NEW,
      client_order_reference_id: body?.order_reference_id,
      orderStages: [{ stage: NEW_ORDER_STATUS, stageDateTime: new Date(), action: NEW_ORDER_DESCRIPTION }],
      pickupAddress: body?.pickupAddress,
      productId: savedProduct._id,
      order_reference_id: body?.order_reference_id,
      payment_mode: body?.payment_mode,
      order_invoice_date: body?.order_invoice_date,
      order_invoice_number: body?.order_invoice_number.toString(),
      isContainFragileItem: body?.isContainFragileItem,
      numberOfBoxes: body?.numberOfBoxes, // if undefined, default=> 0
      orderBoxHeight: body?.orderBoxHeight,
      orderBoxWidth: body?.orderBoxWidth,
      orderBoxLength: body?.orderBoxLength,
      orderSizeUnit: body?.orderSizeUnit,
      orderWeight: body?.orderWeight,
      orderWeightUnit: body?.orderWeightUnit,
      productCount: body?.productCount,
      amount2Collect: body?.amount2Collect,
      customerDetails: body?.customerDetails,
      sellerDetails: {
        sellerName: body?.sellerDetails.sellerName,
        sellerGSTIN: body?.sellerDetails.sellerGSTIN,
        sellerAddress: body?.sellerDetails.sellerAddress,
        isSellerAddressAdded: body?.sellerDetails.isSellerAddressAdded,
        sellerPincode: Number(body?.sellerDetails.sellerPincode),
        sellerCity: body?.sellerDetails.sellerCity,
        sellerState: body?.sellerDetails.sellerState,
        sellerPhone: body?.sellerDetails.sellerPhone,
      },
    };

    if (body?.total_order_value > 50000) {
      //@ts-ignore
      data.ewaybill = body?.ewaybill;
    }
    const order2save = new B2COrderModel(data);
    savedOrder = await order2save.save();
    return res.status(200).send({ valid: true, order: savedOrder });
  } catch (error) {

  }
}

export const createBulkB2COrder = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    if (!body) return res.status(200).send({ valid: false, message: "Invalid payload" });

    if (!req.file || !req.file.buffer) {
      return res.status(400).send({ valid: false, message: "No file uploaded" });
    }
    const existingOrders = await B2COrderModel.find({ sellerId: req.seller._id }).lean();
    const json = await csvtojson().fromString(req.file.buffer.toString('utf8'));

    const orders = json.map((hub: any) => {
      const isPaymentCOD = hub["payment_mode"]?.toUpperCase() === "TRUE" ? 1 : 0;
      const isContainFragileItem = hub["isContainFragileItem"]?.toUpperCase() === "TRUE" ? true : false;
      const isSellerAddressAdded = hub["isSellerAddressAdded"]?.toUpperCase() === "TRUE" ? true : false;
      return {
        order_reference_id: hub["order_reference_id"],
        productDetails: {
          name: hub["ProductName"],
          category: hub["category"],
          quantity: hub["quantity"],
          hsn_code: hub["hsn_code"],
          taxRate: hub["tax_rate"],
          taxableValue: hub["shipment_value"]
        },
        order_invoice_date: hub["order_invoice_date"],
        order_invoice_number: hub["order_invoice_number"],
        isContainFragileItem: Boolean(isContainFragileItem),
        numberOfBoxes: hub["numberOfBoxes"],
        orderBoxHeight: hub["orderBoxHeight(cm)"],
        orderBoxWidth: hub["orderBoxWidth(cm)"],
        orderBoxLength: hub["orderBoxLength(cm)"],
        orderWeight: hub["orderWeight (Kg)"],
        orderWeightUnit: "kg",
        orderSizeUnit: "cm",
        payment_mode: isPaymentCOD,
        amount2Collect: hub['amount2Collect*'],
        customerDetails: {
          name: hub['customerName'],
          phone: "+91" + hub['customerPhone'],
          address: hub['customerAdd'],
          pincode: hub['customerPincode'],
          city: hub['customerCity'],
          state: hub['customerState']
        },
        sellerDetails: {
          sellerName: hub['sellerName'],
          sellerGSTIN: hub['sellerGSTIN'],
          isSellerAddressAdded: Boolean(isSellerAddressAdded),
          sellerAddress: hub['sellerAddress'],
          sellerPincode: hub['sellerPincode'],
          sellerCity: hub['sellerCity'],
          sellerState: hub['sellerState'],
          sellerPhone: "+91" + hub['sellerPhone']
        },
      };
    })

    if (orders.length < 1) {
      return res.status(200).send({
        valid: false,
        message: "empty payload",
      });
    }

    try {
      const errorWorkbook = new exceljs.Workbook();
      const errorWorksheet = errorWorkbook.addWorksheet('Error Sheet');

      errorWorksheet.columns = [
        { header: 'order_reference_id', key: 'order_reference_id', width: 20 },
        { header: 'Error Message', key: 'errors', width: 40 },
      ];

      const errorRows: any = [];

      orders.forEach((order) => {
        const errors: string[] = [];
        Object.entries(order).forEach(([fieldName, value]) => {
          const error = validateBulkOrderField(value, fieldName, orders, existingOrders);
          if (error) {
            errors.push(error);
          }
        });

        if (errors.length > 0) {
          errorRows.push({
            order_reference_id: order.order_reference_id,
            errors: errors.join(", ")
          });
        }

      });

      if (errorRows.length > 0) {
        errorWorksheet.addRows(errorRows);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=error_report.csv');

        await errorWorkbook.csv.write(res);
        return res.end();
      }
    } catch (error) {
      return next(error);
    }

    let hubDetails;
    try {
      hubDetails = await HubModel.findOne({ sellerId: req.seller._id, isPrimary: true });
      if (!hubDetails) return res.status(200).send({ valid: false, message: "Pickup address doesn't exists" });

    } catch (err) {
      return next(err);
    }

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const customerDetails = order?.customerDetails;
      const productDetails = order?.productDetails;

      if (
        !isValidPayload(order, [
          "order_reference_id",
          "payment_mode",
          "customerDetails",
          "productDetails",
        ])
      )
        return res.status(200).send({ valid: false, message: "Invalid payload" });

      if (!isValidPayload(productDetails, ["name", "category", "quantity", "taxRate", "taxableValue"]))
        return res.status(200).send({ valid: false, message: "Invalid payload: productDetails" });
      if (!isValidPayload(customerDetails, ["name", "phone", "address", "pincode"]))
        return res.status(200).send({ valid: false, message: "Invalid payload: customerDetails" });

      if (!(order.payment_mode === 0 || order.payment_mode === 1))
        return res.status(200).send({ valid: false, message: "Invalid payment mode" });
      if (order.payment_mode === 1) {
        if (!order?.amount2Collect) {
          return res.status(200).send({ valid: false, message: "amount2Collect > 0 for COD order" });
        }
      }
      // if (order.total_order_value > 50000) {
      //   if (!isValidPayload(order, ["ewaybill"]))
      //     return res.status(200).send({ valid: false, message: "Ewaybill required." });
      // }

      try {
        const orderWithOrderReferenceId = await B2COrderModel.findOne({
          sellerId: req.seller._id,
          order_reference_id: order?.order_reference_id,
        }).lean();

        if (orderWithOrderReferenceId) {
          const newError = new Error("Order reference Id already exists.");
          return next(newError);
        }
      }
      catch (err) {
        return next(err);
      }


      let savedProduct;
      try {
        const { name, category, hsn_code, quantity, taxRate, taxableValue } = productDetails;
        const product2save = new ProductModel({
          name,
          category,
          hsn_code,
          quantity,
          tax_rate: taxRate,
          taxable_value: taxableValue,
        });
        savedProduct = await product2save.save();
      } catch (err) {
        return next(err);
      }

      let savedOrder;

      const data = {
        sellerId: req.seller?._id,
        bucket: NEW,
        client_order_reference_id: order?.order_reference_id,
        orderStages: [{ stage: NEW_ORDER_STATUS, stageDateTime: new Date(), action: NEW_ORDER_DESCRIPTION }],
        pickupAddress: hubDetails?._id,
        productId: savedProduct._id,
        order_reference_id: order?.order_reference_id,
        payment_mode: order?.payment_mode,
        order_invoice_date: convertToISO(order?.order_invoice_date),
        order_invoice_number: order?.order_invoice_number.toString(),
        isContainFragileItem: order?.isContainFragileItem,
        numberOfBoxes: order?.numberOfBoxes, // if undefined, default=> 0
        orderBoxHeight: order?.orderBoxHeight,
        orderBoxWidth: order?.orderBoxWidth,
        orderBoxLength: order?.orderBoxLength,
        orderSizeUnit: order?.orderSizeUnit,
        orderWeight: order?.orderWeight,
        orderWeightUnit: order?.orderWeightUnit,
        amount2Collect: order?.amount2Collect,
        customerDetails: order?.customerDetails,
        sellerDetails: {
          sellerName: order?.sellerDetails.sellerName,
          sellerGSTIN: order?.sellerDetails.sellerGSTIN,
          sellerAddress: order?.sellerDetails.sellerAddress,
          isSellerAddressAdded: order?.sellerDetails.isSellerAddressAdded,
          sellerPincode: Number(order?.sellerDetails.sellerPincode),
          sellerCity: order?.sellerDetails.sellerCity,
          sellerState: order?.sellerDetails.sellerState,
          sellerPhone: order?.sellerDetails.sellerPhone,
        },
      };

      // if (order?.total_order_value > 50000) {
      //   //@ts-ignore
      //   data.ewaybill = order?.ewaybill;
      // }
      const order2save = new B2COrderModel(data);
      savedOrder = await order2save.save();
    }
    return res.status(200).send({ valid: true });
  } catch (error) {
    return next(error);
  }
}

export const updateB2COrder = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    if (!body) return res.status(200).send({ valid: false, message: "Invalid payload" });

    const customerDetails = body?.customerDetails;
    const productDetails = body?.productDetails;

    if (
      !isValidPayload(body, [
        "order_reference_id",
        "orderId",
        "payment_mode",
        "customerDetails",
        "productDetails",
        "pickupAddress",
      ])
    )
      return res.status(200).send({ valid: false, message: "Invalid payload" });

    if (!isValidPayload(productDetails, ["name", "category", "quantity", "taxRate", "taxableValue"]))
      return res.status(200).send({ valid: false, message: "Invalid payload: productDetails" });
    if (!isValidPayload(customerDetails, ["name", "phone", "address", "pincode", "state", "city"]))
      return res.status(200).send({ valid: false, message: "Invalid payload: customerDetails" });
    if (!isValidObjectId(body.pickupAddress))
      return res.status(200).send({ valid: false, message: "Invalid pickupAddress" });


    if (!(body.payment_mode === 0 || body.payment_mode === 1))
      return res.status(200).send({ valid: false, message: "Invalid payment mode" });
    if (body.payment_mode === 1) {
      if (!body?.amount2Collect) {
        return res.status(200).send({ valid: false, message: "amount2Collect > 0 for COD order" });
      }
    }
    if (body.total_order_value > 50000) {
      if (!isValidPayload(body, ["ewaybill"]))
        return res.status(200).send({ valid: false, message: "Ewaybill required." });
    }

    try {
      const orderWithOrderReferenceId = await B2COrderModel.findOne({
        sellerId: req.seller._id,
        order_reference_id: body?.order_reference_id,
      }).lean();

      if (!orderWithOrderReferenceId) {
        const newError = new Error("Order not found.");
        return next(newError);
      }
    } catch (err) {
      return next(err);
    }

    let hubDetails;
    try {
      hubDetails = await HubModel.findById(body?.pickupAddress);
      if (!hubDetails) return res.status(200).send({ valid: false, message: "Pickup address doesn't exists" });

    } catch (err) {
      return next(err);
    }

    let savedProduct;

    try {
      const { _id, name, category, hsn_code, quantity, taxRate, taxableValue } = productDetails;
      // Find and update the existing product
      savedProduct = await ProductModel.findByIdAndUpdate(_id,
        {
          name,
          category,
          hsn_code,
          quantity,
          tax_rate: taxRate,
          taxable_value: taxableValue,
        });
    } catch (err) {
      return next(err);
    }

    let savedOrder;

    try {
      const data = {
        sellerId: req.seller?._id,
        bucket: NEW,
        orderStages: [{ stage: NEW_ORDER_STATUS, stageDateTime: new Date(), action: NEW_ORDER_DESCRIPTION }],
        pickupAddress: body?.pickupAddress,
        productId: savedProduct?._id,
        order_reference_id: body?.order_reference_id,
        payment_mode: body?.payment_mode,
        order_invoice_date: body?.order_invoice_date,
        order_invoice_number: body?.order_invoice_number.toString(),
        isContainFragileItem: body?.isContainFragileItem,
        numberOfBoxes: body?.numberOfBoxes, // if undefined, default=> 0
        orderBoxHeight: body?.orderBoxHeight,
        orderBoxWidth: body?.orderBoxWidth,
        orderBoxLength: body?.orderBoxLength,
        orderSizeUnit: body?.orderSizeUnit,
        orderWeight: body?.orderWeight,
        orderWeightUnit: body?.orderWeightUnit,
        productCount: body?.productCount,
        amount2Collect: body?.amount2Collect,
        customerDetails: body?.customerDetails,
        sellerDetails: {
          sellerName: body?.sellerDetails.sellerName,
          sellerGSTIN: body?.sellerDetails.sellerGSTIN,
          sellerAddress: body?.sellerDetails.sellerAddress,
          isSellerAddressAdded: body?.sellerDetails.isSellerAddressAdded,
          sellerPincode: Number(body?.sellerDetails.sellerPincode),
          sellerCity: body?.sellerDetails.sellerCity,
          sellerState: body?.sellerDetails.sellerState,
          sellerPhone: body?.sellerDetails.sellerPhone,
        },
      };

      if (body?.total_order_value > 50000) {
        //@ts-ignore
        data.ewaybill = body?.ewaybill;
      }
      // Find and update the existing order
      savedOrder = await B2COrderModel.findByIdAndUpdate(body?.orderId, data);

      return res.status(200).send({ valid: true, order: savedOrder });
    } catch (err) {
      return next(err);
    }
  } catch (error) {
    return next(error);
  }
};

export const updateBulkPickupOrder = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    if (!body) return res.status(200).send({ valid: false, message: "Invalid payload" });

    const { pickupAddress, orderIds } = body;

    if (!isValidObjectId(pickupAddress))
      return res.status(200).send({ valid: false, message: "Invalid pickupAddress" });
    if (!Array.isArray(orderIds))
      return res.status(200).send({ valid: false, message: "Invalid orderIds" });

    try {
      const hubDetails = await HubModel.findById(pickupAddress);
      if (!hubDetails) return res.status(200).send({ valid: false, message: "Pickup address doesn't exists" });

    } catch (err) {
      return next(err);
    }

    let savedOrders = [];
    for (let i = 0; i < orderIds.length; i++) {
      const orderId = orderIds[i];
      try {
        const order = await B2COrderModel.findByIdAndUpdate(orderId, { pickupAddress });
        savedOrders.push(order);
      }
      catch (err) {
        return next(err);
      }
    }
    return res.status(200).send({ valid: true, orders: savedOrders });

  } catch (error) {
    return next(error)
  }
}

export const updateB2CBulkShopifyOrders = async (req: ExtendedRequest, res: Response, next: NextFunction) => {

  try {
    const body = req.body;
    if (!body) return res.status(200).send({ valid: false, message: "Invalid payload" });

    const {
      orderIds,
      pickupAddressId,
      orderSizeUnit,
      orderBoxHeight,
      orderBoxWidth,
      orderBoxLength,
      orderWeight,
    } = body;

    if (!Array.isArray(orderIds))
      return res.status(200).send({ valid: false, message: "Invalid orderIds" });

    if (!isValidObjectId(pickupAddressId))
      return res.status(200).send({ valid: false, message: "Invalid pickupAddressId" });

    const bulkUpdateOrder = await B2COrderModel.bulkWrite(
      orderIds.map((orderId: ObjectId) => ({
        updateOne: {
          filter: { _id: orderId },
          update: {
            pickupAddress: pickupAddressId,
            orderSizeUnit,
            orderBoxHeight,
            orderBoxWidth,
            orderBoxLength,
            orderWeight,
          },
        },
      }))
    );

    return res.status(200).send({ valid: true, orders: bulkUpdateOrder });

  } catch (error) {
    return next(error)
  }
}


export const getOrders = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = req.seller._id;
    let { limit, page, status }: { limit?: number; page?: number; status?: string } = req.query;

    const obj = {
      new: [NEW, RETURN_CONFIRMED],
      "ready-to-ship": [READY_TO_SHIP, RETURN_PICKED],
      "in-transit": [IN_TRANSIT, RETURN_IN_TRANSIT],
      delivered: [DELIVERED, RETURN_DELIVERED],
      ndr: [NDR, RETURN_CANCELLATION],
      rto: [RTO],
    };

    limit = Number(limit);
    page = Number(page);
    page = page < 1 ? 1 : page;
    limit = limit < 1 ? 1 : limit;

    const skip = (page - 1) * limit;

    let orders, orderCount;
    try {
      let query: any = { sellerId };

      if (status && obj.hasOwnProperty(status)) {
        query.bucket = { $in: obj[status as keyof typeof obj] };
      }

      orders = await B2COrderModel
        .find(query)
        .sort({ createdAt: -1 })
        .populate("productId")
        .populate("pickupAddress")
        .lean();

      orderCount =
        status && obj.hasOwnProperty(status)
          ? await B2COrderModel.countDocuments(query)
          : await B2COrderModel.countDocuments({ sellerId });
    } catch (err) {
      return next(err);
    }
    return res.status(200).send({
      valid: true,
      response: { orders, orderCount },
    });
  } catch (error) {
    return next(error);
  }
};

export const getChannelOrders = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const seller = req.seller;
    const sellerId = req.seller._id;
    const shopfiyConfig = await getSellerChannelConfig(sellerId);
    const primaryHub = await HubModel.findOne({ sellerId, isPrimary: true });

    const shopifyOrders = await axios.get(`${shopfiyConfig?.storeUrl}${APIs.SHOPIFY_ORDER}`, {
      headers: {
        "X-Shopify-Access-Token": shopfiyConfig?.sharedSecret,
      },
    });
    const orders = shopifyOrders.data.orders;

    for (let i = orders.length - 1; i >= 0; i--) {
      const order = orders[i];
      const orderDetails = await B2COrderModel.findOne({ sellerId, order_reference_id: order.name }).lean();
      if (!orderDetails) {

        const product2save = new ProductModel({
          name: order.line_items[0]?.name,
          category: order.line_items[0]?.name || order.line_items[0]?.sku,
          quantity: order.line_items[0]?.quantity,
          tax_rate: 0,
          taxable_value: order?.total_price,
        });

        await product2save.save()

        const newOrder = new B2COrderModel({
          sellerId,
          channelOrderId: order.id,
          bucket: NEW,
          channelName: "shopify",
          orderStages: [{ stage: NEW_ORDER_STATUS, stageDateTime: new Date(), action: NEW_ORDER_DESCRIPTION }],
          order_reference_id: order.name,
          order_invoice_date: order.created_at,
          order_invoice_number: order.name,
          orderWeight: order.line_items[0]?.grams / 1000,
          orderWeightUnit: "kg",

          // hard coded values
          orderBoxHeight: 10,
          orderBoxWidth: 10,
          orderBoxLength: 10,
          orderSizeUnit: "cm",

          client_order_reference_id: order.name,
          payment_mode: order?.financial_status === "pending" ? 1 : 0,  // 0 -> prepaid, 1 -> COD, Right now only prepaid, bcoz data not available
          amount2Collect: order?.financial_status === "pending" ? order?.total_price : 0,
          customerDetails: {
            name: order.customer.first_name + " " + order.customer.last_name,
            phone: order?.customer?.default_address?.phone,
            email: order?.customer?.email,
            address: order?.customer?.default_address?.address1,
            pincode: order?.customer?.default_address?.zip,
            city: order?.customer?.default_address?.city,
            state: order?.customer?.default_address?.province,
          },
          sellerDetails: {
            sellerName: seller?.companyProfile?.companyName || seller?.name,
            isSellerAddressAdded: false,
            sellerAddress: order?.billing_address?.address1 || primaryHub?.address1,
            sellerCity: order?.billing_address?.city,
            sellerState: order?.billing_address?.province,
            sellerPincode: 0,
            sellerPhone: order?.billing_address?.phone,
          },
          productId: product2save._id.toString(),
          pickupAddress: primaryHub?._id.toString(),
        });

        await newOrder.save();
      }
    }

    return res.status(200).send({ valid: true });
  } catch (error) {
    console.log("error", error)
    return next(error);
  }
}


export const createB2BOrder = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const body: B2BOrderPayload = req.body;
    if (
      !isValidPayload(body, [
        "client_name",
        "freightType",
        "pickupType",
        "InsuranceType",
        "pickupAddress",
        "invoiceNumber",
        "description",
        "totalOrderValue",
        "amount2Collect",
        "shipperGSTIN",
        "consigneeGSTIN",
        "packageDetails",
        "eways",
        "customerDetails",
      ])
    ) {
      return res.status(200).send({ valid: false, message: "Invalid Payload" });
    }
    if (!isValidObjectId(body?.pickupAddress)) {
      return res.status(200).send({ valid: "Invalid pickupAddress." });
    }
    if (!isValidObjectId(body?.customerDetails)) {
      return res.status(200).send({ valid: "Invalid customerDetails." });
    }
    if (!Array.isArray(body?.packageDetails)) {
      return res.status(200).send({ valid: false, message: "packageDetails should be array" });
    }
    if (!Array.isArray(body?.eways)) {
      return res.status(200).send({ valid: false, message: "eways should be an array" });
    }

    const isAlreadyExists = (await B2BOrderModel.findOne({ client_name: body.client_name }).lean()) !== null;
    if (isAlreadyExists) return res.status(200).send({ valid: false, message: "Client name already exists" });

    const data2save = {
      client_name: body?.client_name,
      sellerId: req.seller._id,
      freightType: body?.freightType, // 0 -> paid, 1 -> toPay
      pickupType: body?.pickupType, // 0 -> FM-Pickup, 1 -> SelfDrop
      InsuranceType: body?.InsuranceType, // 0-> OwnerRisk, 1-> Carrier Risk
      pickupAddress: body?.pickupAddress,
      invoiceNumber: body?.invoiceNumber,
      description: body?.description,
      totalOrderValue: body?.totalOrderValue,
      amount2Collect: body?.amount2Collect,
      gstDetails: {
        shipperGSTIN: body?.shipperGSTIN,
        consigneeGSTIN: body?.consigneeGSTIN,
      },
      packageDetails: [
        ...body.packageDetails,
      ],
      eways: [
        ...body?.eways,
      ],
      customers: [body?.customerDetails],
    };
    try {
      const B2BOrder2Save = new B2BOrderModel(data2save);
      const savedOrder = await B2BOrder2Save.save();
      return res.status(200).send({ valid: true, order: savedOrder });
    } catch (err) {
      return next(err);
    }
    return res.status(500).send({ valid: true, message: "Incomplete route", data2save });
  } catch (error) {
    return next(error);
  }
};

export const getCourier = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const productId = req.params.id;
    const type = req.params.type;
    const users_vendors = req.seller.vendors
    let data2send: any;
    let orderDetails: any;
    if (type === "b2c") {
      try {
        orderDetails = await B2COrderModel.findOne({ _id: productId, sellerId: req.seller._id }).populate(["pickupAddress", "productId"]);
      } catch (err) {
        return next(err);
      }
    } else {
      return res.status(200).send({ valid: false, message: "Invalid order type" });
      try {
        orderDetails = await B2BOrderModel.findById(productId);
      } catch (err) {
        return next(err);
      }
    }
    const pickupPincode = orderDetails.pickupAddress.pincode;
    const deliveryPincode = orderDetails.customerDetails.get("pincode");
    const weight = orderDetails.orderWeight;
    const orderWeightUnit = orderDetails.orderWeightUnit;
    const boxLength = orderDetails.orderBoxLength;
    const boxWeight = orderDetails.orderBoxWidth;
    const boxHeight = orderDetails.orderBoxHeight;
    const sizeUnit = orderDetails.orderSizeUnit;
    const paymentType = orderDetails.payment_mode;
    const sellerId = req.seller._id;
    const collectableAmount = orderDetails?.amount2Collect;

    const hubId = orderDetails.pickupAddress.hub_id;

    let shiprocketOrder;
    const shiprocketToken = await getShiprocketToken();
    if (!shiprocketToken) return res.status(200).send({ valid: false, message: "Invalid token" });

    const orderPayload = {
      order_id: orderDetails?.client_order_reference_id,
      order_date: format(orderDetails?.order_invoice_date, 'yyyy-MM-dd HH:mm'),
      pickup_location: orderDetails?.pickupAddress?.name,
      billing_customer_name: orderDetails?.customerDetails.get("name"),
      billing_last_name: orderDetails?.customerDetails.get("name") || "",
      billing_address: orderDetails?.customerDetails.get("address"),
      billing_city: orderDetails?.customerDetails.get("city"),
      billing_pincode: orderDetails?.customerDetails.get("pincode"),
      billing_state: orderDetails?.customerDetails.get("state"),
      billing_country: "India",
      billing_email: orderDetails?.customerDetails.get("email") || "noreply@lorrigo.com",
      billing_phone: orderDetails?.customerDetails.get("phone").replace("+91", ""),
      order_items: [
        {
          name: orderDetails.productId.name,
          sku: orderDetails.productId.category.slice(0, 40),
          units: 1,
          selling_price: Number(orderDetails.productId.taxable_value),
        }
      ],
      payment_method: orderDetails?.payment_mode === 0 ? "Prepaid" : "COD",
      sub_total: Number(orderDetails.productId?.taxable_value),
      length: 20,
      breadth: 10,
      height: 10,
      weight: 0.5,

    };

    if (orderDetails?.isReverseOrder) {
      Object.assign(orderPayload, {
        pickup_customer_name: orderDetails?.customerDetails?.get("name"),
        pickup_phone: orderDetails?.customerDetails?.get("phone").toString().slice(2, 12),
        pickup_address: orderDetails?.customerDetails?.get("address"),
        pickup_pincode: orderDetails?.customerDetails?.get("pincode"),
        pickup_city: orderDetails?.customerDetails?.get("city"),
        pickup_state: orderDetails?.customerDetails?.get("state"),
        pickup_country: "India",
        shipping_customer_name: orderDetails?.pickupAddress?.name,
        shipping_country: "India",
        shipping_address: orderDetails?.pickupAddress?.address1,
        shipping_pincode: orderDetails?.pickupAddress?.pincode,
        shipping_city: orderDetails?.pickupAddress?.city,
        shipping_state: orderDetails?.pickupAddress?.state,
        shipping_phone: orderDetails?.pickupAddress?.phone.toString().slice(2, 12)
      });
    } else {
      Object.assign(orderPayload, {
        shipping_is_billing: true,
        shipping_customer_name: orderDetails?.sellerDetails.get("sellerName") || "",
        shipping_last_name: orderDetails?.sellerDetails.get("sellerName") || "",
        shipping_address: orderDetails?.sellerDetails.get("sellerAddress"),
        shipping_address_2: "",
        shipping_city: orderDetails?.sellerDetails.get("sellerCity"),
        shipping_pincode: orderDetails?.sellerDetails.get("sellerPincode"),
        shipping_country: "India",
        shipping_state: orderDetails?.sellerDetails.get("sellerState"),
        shipping_phone: orderDetails?.sellerDetails.get("sellerPhone")
      });
    }

    const shiprocketAPI = orderDetails.isReverseOrder ? APIs.CREATE_SHIPROCKET_RETURN_ORDER : APIs.CREATE_SHIPROCKET_ORDER;

    try {
      if (!orderDetails.shiprocket_order_id) {
        shiprocketOrder = await axios.post(envConfig.SHIPROCKET_API_BASEURL + shiprocketAPI, orderPayload, {
          headers: {
            Authorization: shiprocketToken,
          },
        });
        orderDetails.shiprocket_order_id = shiprocketOrder.data.order_id;
        orderDetails.shiprocket_shipment_id = shiprocketOrder.data.shipment_id;
        await orderDetails.save();
      }
    } catch (error: any) {
      console.log("error", error.response.data.errors);
    }

    const shiprocketOrderID = orderDetails?.shiprocket_order_id ?? 0;

    data2send = await rateCalculation(
      shiprocketOrderID,
      pickupPincode,
      deliveryPincode,
      weight,
      orderWeightUnit,
      boxLength,
      boxWeight,
      boxHeight,
      sizeUnit,
      paymentType,
      users_vendors,
      sellerId,
      collectableAmount,
      hubId,
    );

    return res.status(200).send({
      valid: true,
      courierPartner: data2send,
      orderDetails,
    });
  } catch (error: any) {
    console.log("error", error.response.data.errors)
    return next(error);
  }
};

export const getSpecificOrder = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const orderId = req.params?.id;
    if (!isValidObjectId(orderId)) {
      return res.status(200).send({ valid: false, message: "Invalid orderId" });
    }
    //@ts-ignore
    const order = await B2COrderModel.findById(orderId).populate(["pickupAddress", "productId"]).lean();

    return !order
      ? res.status(200).send({ valid: false, message: "No such order found." })
      : res.status(200).send({ valid: true, order: order });
  } catch (error) {
    return next(error)
  }
};

type PickupAddress = {
  name: string;
  pincode: string;
  city: string;
  state: string;
  address1: string;
  address2?: string;
  phone: number;
  delivery_type_id?: number;
  isSuccess?: boolean;
  code?: number;
  message?: string;
  hub_id?: number;
};

type B2BOrderPayload = {
  // here client_name would be work as client_reference_id
  client_name: string;
  freightType: number;
  pickupType: number;
  InsuranceType: number;
  pickupAddress: ObjectId;
  invoiceNumber: string;
  description: string;
  totalOrderValue: number;
  amount2Collect: number;
  shipperGSTIN: string;
  consigneeGSTIN: string;
  packageDetails: any;
  eways: any;
  customerDetails: ObjectId;
};
