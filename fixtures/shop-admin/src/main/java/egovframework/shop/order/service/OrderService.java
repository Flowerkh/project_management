package egovframework.shop.order.service;

import java.util.List;
import egovframework.rte.psl.dataaccess.util.EgovMap;

public interface OrderService {
    Object selectOrderList(OrderVO vo) throws Exception;
    Object selectOrder(OrderVO vo) throws Exception;
    Object selectOrderItemList(OrderVO vo) throws Exception;
    Object selectOrderDlvy(OrderVO vo) throws Exception;
    Object selectPay(OrderVO vo) throws Exception;
    Object updateOrderStat(OrderVO vo) throws Exception;
    Object insertOrderHist(OrderVO vo) throws Exception;
    Object updateDlvyStat(OrderVO vo) throws Exception;
    Object selectDlvyList(OrderVO vo) throws Exception;
    Object selectClaimList(OrderVO vo) throws Exception;
    Object insertClaim(OrderVO vo) throws Exception;
    Object updateClaimStat(OrderVO vo) throws Exception;
    Object selectOrderHistList(OrderVO vo) throws Exception;
}
