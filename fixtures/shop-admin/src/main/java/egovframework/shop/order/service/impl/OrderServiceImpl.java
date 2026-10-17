package egovframework.shop.order.service.impl;

import javax.annotation.Resource;
import org.springframework.stereotype.Service;
import egovframework.rte.fdl.cmmn.EgovAbstractServiceImpl;
import egovframework.shop.order.service.OrderService;
import egovframework.shop.order.service.OrderVO;

@Service("orderservice")
public class OrderServiceImpl extends EgovAbstractServiceImpl implements OrderService {

    @Resource(name = "orderdao")
    private OrderDAO orderdao;

    @Override
    public Object selectOrderList(OrderVO vo) throws Exception {
        return orderdao.selectOrderList(vo);
    }

    @Override
    public Object selectOrder(OrderVO vo) throws Exception {
        return orderdao.selectOrder(vo);
    }

    @Override
    public Object selectOrderItemList(OrderVO vo) throws Exception {
        return orderdao.selectOrderItemList(vo);
    }

    @Override
    public Object selectOrderDlvy(OrderVO vo) throws Exception {
        return orderdao.selectOrderDlvy(vo);
    }

    @Override
    public Object selectPay(OrderVO vo) throws Exception {
        return orderdao.selectPay(vo);
    }

    @Override
    public Object updateOrderStat(OrderVO vo) throws Exception {
        return orderdao.updateOrderStat(vo);
    }

    @Override
    public Object insertOrderHist(OrderVO vo) throws Exception {
        return orderdao.insertOrderHist(vo);
    }

    @Override
    public Object updateDlvyStat(OrderVO vo) throws Exception {
        return orderdao.updateDlvyStat(vo);
    }

    @Override
    public Object selectDlvyList(OrderVO vo) throws Exception {
        return orderdao.selectDlvyList(vo);
    }

    @Override
    public Object selectClaimList(OrderVO vo) throws Exception {
        return orderdao.selectClaimList(vo);
    }

    @Override
    public Object insertClaim(OrderVO vo) throws Exception {
        return orderdao.insertClaim(vo);
    }

    @Override
    public Object updateClaimStat(OrderVO vo) throws Exception {
        return orderdao.updateClaimStat(vo);
    }

    @Override
    public Object selectOrderHistList(OrderVO vo) throws Exception {
        return orderdao.selectOrderHistList(vo);
    }

}
