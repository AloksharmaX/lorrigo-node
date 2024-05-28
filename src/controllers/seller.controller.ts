import { NextFunction, Response } from "express";
import { ExtendedRequest } from "../utils/middleware";
import SellerModel from "../models/seller.model";
import RemittanceModel from "../models/remittance-modal";
import ChannelModel from "../models/channel.model";
import axios from "axios";
import APIs from "../utils/constants/third_party_apis";
import envConfig from "../utils/config";
import ClientBillingModal from "../models/client.billing.modal";
import sha256 from "sha256";

export const getSeller = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const seller = await req.seller;
    delete seller?.password;
    delete seller?.__v;
    return res.status(200).send({ valid: true, seller });
  } catch (error) {
    return next(error);
  }
};

export const updateSeller = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    const sellerId = req.seller._id;
    const query: { [key: string]: any } = {};

    try {
      if (req.file && req.file.buffer) {
        const logo = req.file.buffer.toString('base64');
        query['companyProfile.logo'] = logo;
      }
    } catch (error) {
      console.log(error, "error[Logo error]");
    }
    const existingSeller = await SellerModel.findById(sellerId);
    if (!existingSeller) {
      throw new Error("Seller not found");
    }

    if (existingSeller.companyProfile) {
      body.companyProfile = {
        ...existingSeller.companyProfile,
        ...body.companyProfile,
        companyId: existingSeller.companyProfile.companyId,
        companyLogo: query['companyProfile.logo'] || existingSeller.companyProfile.companyLogo
      };
    }

    const updatedSeller = await SellerModel.findByIdAndUpdate(sellerId, {
      $set: { ...body },
    }, { new: true }).select([
      "-__v",
      "-password",
      "-margin",
    ]);

    return res.status(200).send({
      valid: true,
      message: "updated success",
      seller: updatedSeller,
    });
  } catch (err) {
    return next(err);
  }
};

export const uploadKycDocs = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = req.seller._id;
    const files = req.files as any;

    const { businessType, gstin, pan, photoUrl, submitted, verified, document1Feild, document2Feild, document1Type, document2Type } = req.body;

    if (!files['document1Front'] || !files['document1Back'] || !files['document2Front'] || !files['document2Back']) {
      return res.status(400).json({ message: 'All files are required' });
    }

    // || !pan  is missing, have to add it
    if (!businessType || !photoUrl || !submitted || !verified) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const document1Front = files['document1Front'][0].buffer.toString('base64');
    const document1Back = files['document1Back'][0].buffer.toString('base64');
    const document2Front = files['document2Front'][0].buffer.toString('base64');
    const document2Back = files['document2Back'][0].buffer.toString('base64');

    const companyID = `LS${Math.floor(1000 + Math.random() * 9000)}`;

    // Retrieve existing seller document
    const existingSeller = await SellerModel.findById(sellerId);
    if (!existingSeller) {
      throw new Error("Seller not found");
    }

    // Merge new KYC details with existing ones
    const updatedKycDetails = {
      ...existingSeller.kycDetails,
      businessType,
      gstin,
      pan,
      photoUrl: photoUrl.split(",")[1],
      document1Type,
      document1Front,
      document1Back,
      document2Type,
      document2Front,
      document2Back,
      document1Feild,
      document2Feild,
      submitted,
      verified
    };

    // Update seller document
    const updatedSeller = await SellerModel.findByIdAndUpdate(
      sellerId,
      {
        $set: {
          kycDetails: updatedKycDetails,
          // Ensure companyId remains unchanged
          companyProfile: { ...existingSeller.companyProfile, companyId: companyID }
        }
      },
      { new: true }
    ).select(["-__v", "-password", "-margin"]);

    return res.status(200).json({
      valid: true,
      message: 'File uploaded successfully',
      seller: updatedSeller,
    });
  } catch (err) {
    console.log(err, "error")
    return next(err);
  }
};

export const deleteSeller = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  const seller = req.seller;
  const sellerId = seller._id;

  try {
    const deletedSeller = await SellerModel.findByIdAndDelete(sellerId);
    return res.status(200).send({
      valid: true,
      seller: deletedSeller,
    });
  } catch (err) {
    return next(err);
  }
  return res.status(200).send({
    valid: false,
    message: "incomplete route",
  });
};

export const getRemittaces = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const remittanceOrders = await RemittanceModel.find({ sellerId: req.seller._id });
    if (!remittanceOrders) return res.status(200).send({ valid: false, message: "No Remittance found" });

    return res.status(200).send({
      valid: true,
      remittanceOrders,
    });
  } catch (error) {
    return next(error)
  }
}

export const getRemittaceByID = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const remittanceOrder = await RemittanceModel.findById(req.params.id);
    if (!remittanceOrder) return res.status(200).send({ valid: false, message: "No Remittance found" });

    return res.status(200).send({
      valid: true,
      remittanceOrder,
    });
  } catch (error) {
    return next(error)
  }
}

export const manageChannelPartner = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const {
      channel: {
        channelName,
        isOrderSync,
        storeUrl,
        apiKey,
        apiSk,
        sharedSecret,
      }
    } = req.body;

    if (!channelName || !isOrderSync || !storeUrl || !apiKey || !apiSk || !sharedSecret) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const testChannel = await axios.get(`${storeUrl}${APIs.SHOPIFY_CUSTOMER}`, {
      headers: {
        "X-Shopify-Access-Token": sharedSecret,
      }
    });

    const channel = await ChannelModel.create({
      sellerId: req.seller._id,
      channelName,
      isOrderSync,
      storeUrl,
      apiKey,
      apiSk,
      sharedSecret,
    });

    const seller = await SellerModel.findByIdAndUpdate(req.seller._id, {
      $push: { channelPartners: channel._id }
    });

    return res.status(200).send({
      valid: true,
      message: "Channel created successfully",
      channel,
    });
  } catch (error) {
    console.log(error, "error [manageChannelPartner]")
    return next(error)
  }
}

export const updateChannelPartner = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { channel: { isOrderSync } } = req.body;

    const channel = await ChannelModel.findByIdAndUpdate(id, {
      isOrderSync,
    });

    return res.status(200).send({
      valid: true,
      message: "Channel updated successfully",
      channel,
    });

  } catch (error) {
    console.log(error, "error [manageChannelPartner]")
    return next(error)
  }
}

export const getSellerBilling = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  try {
    const bills = await ClientBillingModal.find({ sellerId: req.seller._id });
    if (!bills) return res.status(200).send({ valid: false, message: "No Seller found" });

    return res.status(200).send({
      valid: true,
      billing: bills,
    });
  } catch (error) {
    return next(error)
  }
}

export const rechargeWallet = async (req: ExtendedRequest, res: Response, next: NextFunction) => {
  const sellerId = req.seller._id;
  const { amount } = req.body;
  // Phonepe Integration
  // working on it
  try {

    const merchantTransactionId = `MT${Math.floor(1000 + Math.random() * 9000)}`;
    const payload = {
      "merchantId": envConfig.PHONEPE_MERCHENT_ID,
      "merchantTransactionId": merchantTransactionId,
      "merchantUserId": sellerId._id.toString(),
      "amount": amount * 100, // 100 paise = 1 rupee
      "redirectUrl": `${envConfig.PHONEPE_SUCCESS_URL}/${merchantTransactionId}`,
      "redirectMode": "REDIRECT",
      "callbackUrl": `${envConfig.LORRIGO_DOMAIN}`,
      "mobileNumber": "9999999999",
      "paymentInstrument": {
        "type": "PAY_PAGE"
      }
    }

    const bufferObj = Buffer.from(JSON.stringify(payload));
    const base64Payload = bufferObj.toString('base64');
    const xVerify = sha256(base64Payload + APIs.PHONEPE_PAY_API + envConfig.PHONEPE_SALT_KEY) + "###" + envConfig.PHONEPE_SALT_INDEX;

    const options = {
      method: 'post',
      url: `${envConfig.PHONEPE_API_BASEURL}${APIs.PHONEPE_PAY_API}`,
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
      },
      data: {
        request: base64Payload
      }
    };

    const rechargeWalletViaPhoenpe = await axios.request(options);

    return res.status(200).send({
      valid: true,
      message: "Wallet recharged successfully",
      rechargeWalletViaPhoenpe,
    });
  } catch (error) {
    console.log(error, "error [rechargeWallet]")
    return next(error)
  }
}