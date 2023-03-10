const cds = require('@sap/cds');


// module.exports = cds.service.impl(async (srv) => {
  class SalesService extends cds.ApplicationService {

    async init(){
      
      const srv = this;
      const {BusinessPartnerAddress, Notifications, Addresses, BusinessPartner} = srv.entities;
      const bupaSrv = await cds.connect.to("API_BUSINESS_PARTNER");
      const messaging = await cds.connect.to('messaging')
      const {postcodeValidator} = require('postcode-validator');
      srv.LOG = cds.log("sales-service");
    
      srv.on("READ", BusinessPartnerAddress, req => bupaSrv.run(req.query))
      srv.on("READ", BusinessPartner, req => bupaSrv.run(req.query))
    
      messaging.on(["S4H/BO/BusinessPartner/Created", "ce/sap/s4/beh/businesspartner/v1/BusinessPartner/Created/v1"], async msg => {
        
        srv.LOG.info("<< Create event caught", msg.data);
        let BUSINESSPARTNER = this.readMsg(msg);
          
        // ID has prefix 000 needs to be removed to read address
        srv.LOG.info(BUSINESSPARTNER);
        const bpEntity = await bupaSrv.run(SELECT.one(BusinessPartner).where({businessPartnerId: BUSINESSPARTNER}));
        if(!bpEntity){
          srv.LOG.info(`BP doesn't exist in the given destination`);
          return;
        }
        const result = await cds.run(INSERT.into(Notifications).entries({businessPartnerId:BUSINESSPARTNER, verificationStatus_code:'N', businessPartnerName:bpEntity.businessPartnerName}));
        const address = await bupaSrv.run(SELECT.one(BusinessPartnerAddress).where({businessPartnerId: BUSINESSPARTNER}));
        // for the address to notification association - extra field
    
        console.log("Address entity here == ", address);
        if(address && address.addressId){
          const notificationObj = await cds.run(SELECT.one(Notifications).columns("ID").where({businessPartnerId: BUSINESSPARTNER}));
          address.notifications_ID=notificationObj.ID;
          const res = await cds.run(INSERT.into(Addresses).entries(address));
          srv.LOG.info("Address inserted");
        }
      });
    
      messaging.on(["S4H/BO/BusinessPartner/Changed", "ce/sap/s4/beh/businesspartner/v1/BusinessPartner/Changed/v1"], async msg => {
        srv.LOG.info(`<< Change event caught: ${JSON.stringify(msg.data)}`);
        let BUSINESSPARTNER = this.readMsg(msg);
        const bpIsAlive = await cds.run(SELECT.one(Notifications, (n) => n.verificationStatus_code).where({businessPartnerId: BUSINESSPARTNER}));
        if(bpIsAlive && bpIsAlive.verificationStatus_code == "V"){
          const bpMarkVerified= await cds.run(UPDATE(Notifications).where({businessPartnerId: BUSINESSPARTNER}).set({verificationStatus_code:"C"}));
          srv.LOG.info("<< BP marked verified >> ", bpMarkVerified);
        }    
        
      });
    
      srv.after("UPDATE", "Notifications", (data) => {
        if(data.verificationStatus_code === "V" || data.verificationStatus_code === "INV")
        srv.emitEvent(bupaSrv, data, this.LOG);
        
      });
    
      srv.before("SAVE", "Notifications", req => {
        if(req.data.verificationStatus_code == "C"){
          req.error({code: '400', message: "Cannot mark as COMPLETED. Please change to VERIFIED", numericSeverity:2, target: 'verificationStatus_code'});
        }
      });
    
      srv.before("PATCH", "Addresses", req => {
        // To set whether address is Edited
        req.data.isModified = true;
      });
    
      srv.after("PATCH", "Addresses", (data, req) => {
        const isValidPinCode = postcodeValidator(data.postalCode, data.country);
        if(!isValidPinCode){
          return req.error({code: '400', message: "invalid postal code", numericSeverity:2, target: 'postalCode'});
        } 
        return req.info({numericSeverity:1, target: 'postalCode'});  
      });
      
      await super.init()
    }

    readMsg(msg) {
      if (msg.headers && msg.headers.specversion == "1.0") {
        //> Fix for 2020 on-premise
        return (+(msg.data.BusinessPartner)).toString();
      }
      else {
         return (+(msg.data.KEY[0].BUSINESSPARTNER)).toString();
      }
    }

  async emitEvent(bupaSrv, result, LOG){
    const {BusinessPartner, BusinessPartnerAddress} = this.entities;
    const resultJoin =  await cds.run(SELECT.one("my.businessPartnerValidation.Notifications as N").leftJoin("my.businessPartnerValidation.Addresses as A").on("N.businessPartnerId = A.businessPartnerId").where({"N.ID": result.ID}));
    const statusValues={"N":"NEW", "P":"PROCESS", "INV":"INVALID", "V":"VERIFIED"}

    if(resultJoin.isModified){
      let payload = {
        streetName: resultJoin.streetName,
        postalCode: resultJoin.postalCode
      }

      LOG.info("<<<<payload address", payload)
      let res = await bupaSrv.run(UPDATE(BusinessPartnerAddress).set(payload).where({businessPartnerId:resultJoin.businessPartnerId, addressId:resultJoin.addressId}));
      
      LOG.info(`address update to S/4 Backend system`, res);
    }

    let payload = {
      "searchTerm1": statusValues[resultJoin.verificationStatus_code],
      "businessPartnerIsBlocked": (resultJoin.verificationStatus_code == "V")?false:true
    }

    console.log("payload === ", payload);
    let res =  await bupaSrv.run(UPDATE(BusinessPartner).set(payload).where({businessPartnerId:resultJoin.businessPartnerId}));
    LOG.info(`Search Term update in S/4 Backend`,res);
    
  }
  
};

module.exports = SalesService
