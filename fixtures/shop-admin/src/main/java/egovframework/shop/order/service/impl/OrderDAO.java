package egovframework.shop.order.service.impl;

import java.util.List;
import org.springframework.stereotype.Repository;
import egovframework.rte.psl.dataaccess.EgovAbstractMapper;
import egovframework.shop.order.service.OrderVO;

@Repository("orderdao")
public class OrderDAO extends EgovAbstractMapper {

    public Object selectOrderList(OrderVO vo) throws Exception {
        return selectList("orderdao.selectOrderList", vo);
    }

    public Object selectOrder(OrderVO vo) throws Exception {
        return selectOne("orderdao.selectOrder", vo);
    }

    public Object selectOrderItemList(OrderVO vo) throws Exception {
        return selectList("orderdao.selectOrderItemList", vo);
    }

    public Object selectOrderDlvy(OrderVO vo) throws Exception {
        return selectOne("orderdao.selectOrderDlvy", vo);
    }

    public Object selectPay(OrderVO vo) throws Exception {
        return selectOne("orderdao.selectPay", vo);
    }

    public Object updateOrderStat(OrderVO vo) throws Exception {
        return update("orderdao.updateOrderStat", vo);
    }

    public Object insertOrderHist(OrderVO vo) throws Exception {
        return insert("orderdao.insertOrderHist", vo);
    }

    public Object updateDlvyStat(OrderVO vo) throws Exception {
        return update("orderdao.updateDlvyStat", vo);
    }

    public Object selectDlvyList(OrderVO vo) throws Exception {
        return selectList("orderdao.selectDlvyList", vo);
    }

    public Object selectClaimList(OrderVO vo) throws Exception {
        return selectList("orderdao.selectClaimList", vo);
    }

    public Object insertClaim(OrderVO vo) throws Exception {
        return insert("orderdao.insertClaim", vo);
    }

    public Object updateClaimStat(OrderVO vo) throws Exception {
        return update("orderdao.updateClaimStat", vo);
    }

    public Object selectOrderHistList(OrderVO vo) throws Exception {
        return selectList("orderdao.selectOrderHistList", vo);
    }

}
