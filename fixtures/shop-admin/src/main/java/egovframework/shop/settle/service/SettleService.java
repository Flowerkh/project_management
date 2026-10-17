package egovframework.shop.settle.service;

import java.util.List;
import egovframework.rte.psl.dataaccess.util.EgovMap;

public interface SettleService {
    Object selectSettleList(SettleVO vo) throws Exception;
    Object selectSettle(SettleVO vo) throws Exception;
    Object selectSettleItemList(SettleVO vo) throws Exception;
    Object updateSettleStat(SettleVO vo) throws Exception;
    Object selectSellerList(SettleVO vo) throws Exception;
    Object insertSeller(SettleVO vo) throws Exception;
    Object selectSalesMonthly(SettleVO vo) throws Exception;
}
